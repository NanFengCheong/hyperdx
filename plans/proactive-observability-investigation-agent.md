# Plan: Proactive Observability Investigation Agent

> Source PRD: `prds/proactive-observability-investigation-agent.md`

## Architectural Decisions

Durable decisions that apply across all phases:

- **Task names**: `PROACTIVE_INVESTIGATION_TRIAGE` + `PROACTIVE_INVESTIGATION_RUN` — split from the existing single `PROACTIVE_INVESTIGATION` value in the TaskName enum
- **Schema strategy**: Investigation and InvestigationMemory extended in-place; all new fields are optional so existing documents are unaffected; no new collections
- **Config storage**: PlatformSetting document keyed `'proactiveInvestigation'`; defaults inserted on first boot with `enabled: false`; secrets (model API key) in env vars only
- **System user**: singleton `proactive-agent@system` (isSystem: true, team-less) bootstrapped in the existing setup-defaults path; used as `createdBy` on all agent-created documents
- **Alert lifecycle**: `DRAFT` state added to existing AlertState enum; check-alerts evaluator skips DRAFT investigations; humans promote via UI
- **Routes**: `PATCH /platform/settings/proactive-investigation` (platform-admin role); `GET /investigations` extended with `?source=proactive`; `GET /investigations/:id` extended with artifacts + memory fields
- **Phase vocabulary**: prompt phases (`hypothesize / gather / challenge / report`) map to schema phases (`plan / execute / verify / summarize`) inside the loop controller — the model never sees schema names
- **Fingerprint**: pure sha1 function, no LLM, deterministic fallback chain (exceptionType → errorKind → httpStatus:operation → normalized error message → 'unknown')
- **AI SDK pattern**: single `streamText` multi-turn conversation per investigation; `STEP:` tag parsed from visible output only (think-blocks stripped before parsing); tool registry filtered to ≤5 tools per phase

---

## Phase 1: Schema + Config Foundation

**User stories**: 10, 11, 13, 14, 15

### What to build

Extend the existing data models and wire up the configuration system end-to-end — from the Zod schema in common-utils through the PlatformSetting Mongo document to a new guarded REST endpoint. No investigation behavior ships in this phase; the goal is that the entire feature can be toggled safely via `enabled: false` from day one.

Specifically:
- **Investigation schema**: extend status enum to `pending | active | resolved | failed | ignored | needs_review | exported`; extend `entryPoint.type` with `'proactive'`; add optional fields `source`, `sourceRef`, `fingerprint`, `reopenedFrom`, `resolvedBy`, `leaseExpiresAt`, `attemptCount`, `lastError`, `artifacts`, `budget`; add new Mongoose indexes
- **InvestigationMemory schema**: add `fingerprint` field and its compound index
- **Alert schema**: add `DRAFT` to AlertState enum; update check-alerts to skip DRAFT
- **Zod config schema**: `ProactiveInvestigationConfigSchema` in `packages/common-utils/src/types/`
- **PlatformSetting bootstrap**: on boot, insert default config record (`enabled: false`) if absent
- **System user bootstrap**: extend setup-defaults to create `proactive-agent@system` if absent
- **Config loader**: cached PlatformSetting reader (30-second in-process TTL); cache invalidated on write
- **Admin endpoint**: `PATCH /platform/settings/proactive-investigation` guarded by platform-admin role
- **migrate-mongo migration**: new Investigation indexes; default PlatformSetting insert

### Acceptance criteria

- [ ] All new Investigation fields are optional; existing Investigation documents load without error after the migration
- [ ] `InvestigationMemory` documents load without error; existing records have no `fingerprint` value
- [ ] `AlertState.DRAFT` exists in the enum; a DRAFT alert created directly in Mongo is skipped by the check-alerts task
- [ ] `ProactiveInvestigationConfigSchema` in common-utils parses a valid config object and applies defaults for missing fields
- [ ] On clean boot with no PlatformSetting record, the bootstrap inserts one with `enabled: false` and all schema defaults
- [ ] `proactive-agent@system` user exists after boot; re-running setup-defaults does not create a duplicate
- [ ] `PATCH /platform/settings/proactive-investigation` with a valid payload succeeds for a platform-admin user and is rejected (403) for a non-admin user
- [ ] Config loader returns schema defaults on Mongo miss; returns overridden values on Mongo hit; a write invalidates the cache so the next read reflects the new value within one cache cycle

---

## Phase 2: Triage Task

**User stories**: 16, 17, 18

### What to build

Ship `PROACTIVE_INVESTIGATION_TRIAGE` as a running scheduled task. It discovers investigation candidates from two sources — firing alerts and a ClickHouse error-rate anomaly sweep — deduplicates them by fingerprint, and inserts `pending` Investigation documents. It also runs a lease reaper to recover stalled active investigations.

No LLM is involved. The task can be deployed and observed with `enabled: false` in production to validate candidate volume and dedup behavior before the runner ships.

Specifically:
- **Task registration**: `PROACTIVE_INVESTIGATION_TRIAGE` in TaskName enum, registered in createTask() factory, default cron `*/2 * * * *`
- **Alert candidate enumeration**: query Alert where `state === ALERT` with no active/pending investigation linked via `entryPoint.alertId`
- **Anomaly sweep**: one ClickHouse aggregated query per team; computes top-K services by error-count delta vs 6-hour baseline; returns serviceName, errorCount, ratio, exceptionType, errorKind, topHttpStatusBucket, topOperationName, topErrorMessage
- **Threshold filtering**: keep candidates where `ratio >= errorRateMultiplier` AND `errorCount >= minAbsoluteCount`, trim to topK
- **Fingerprint computation**: pure function, sha1-based, per the deterministic fallback chain in the architectural decisions above
- **Dedup**: skip if `(team, fingerprint, status∈[pending,active])` exists; if resolved/needs_review with same fingerprint and `resolvedAt` older than `reopenAfterHours`, insert new investigation with `reopenedFrom` set
- **Pending insert**: `status=pending`, `entryPoint.type='proactive'`, `source`, `sourceRef`, `fingerprint`, `attemptCount=0`, `budget` copied from config defaults, `createdBy=systemUser`
- **Lease reaper**: flip `active` investigations with `leaseExpiresAt < now` back to `pending` and increment `attemptCount`; if `attemptCount > 3`, flip to `failed`
- **Circuit breaker check**: skip teams where `team.flags.proactiveInvestigationPausedUntil` is in the future
- **Config gate**: return immediately if `config.enabled === false`

### Acceptance criteria

- [ ] Task runs on the configured cron and completes without error when `enabled: true`
- [ ] A firing alert with no existing active/pending investigation produces exactly one `pending` Investigation document
- [ ] Running the triage tick a second time against the same firing alert does not insert a duplicate (dedup by fingerprint)
- [ ] A service with error-count ratio above the configured threshold and above the minimum absolute count produces a `pending` Investigation
- [ ] A service below either threshold does not produce an Investigation
- [ ] A resolved Investigation with the same fingerprint and `resolvedAt` older than `reopenAfterHours` triggers a new Investigation with `reopenedFrom` set to the prior investigation's ID
- [ ] A resolved Investigation with the same fingerprint resolved more recently than `reopenAfterHours` is not reopened
- [ ] An active Investigation with `leaseExpiresAt` in the past is flipped to `pending` and `attemptCount` is incremented by the lease reaper
- [ ] An Investigation that has been re-queued more than 3 times transitions to `failed`
- [ ] A team with `proactiveInvestigationPausedUntil` in the future is skipped entirely
- [ ] Task returns immediately when `config.enabled === false`

---

## Phase 3: Runner Task + Agent Loop + Artifact Writing

**User stories**: 1, 2, 3, 4, 5, 6, 7, 18, 19, 20

### What to build

Ship the full investigation pipeline end-to-end: the `PROACTIVE_INVESTIGATION_RUN` scheduled task claims pending investigations, executes the 4-phase agent loop via the AI SDK, writes artifacts (saved search, dashboard, draft alert) to existing Mongo collections, and upserts an InvestigationMemory record on success.

This phase includes the agent loop refactor of `investigation-agent.ts` and all new tools.

**Runner task**:
- `PROACTIVE_INVESTIGATION_RUN` in TaskName, default cron `*/5 * * * *`
- Atomic claim via `findOneAndUpdate` sorted by `createdAt` FIFO; sets `status=active`, `leaseExpiresAt`, `budget.startedAt`
- Per-team rate limit: skip teams exceeding `maxRunsPerTeamHour` in the rolling window
- Circuit breaker accounting: if a team exceeds `circuitBreaker.maxFailuresPerHour` failures, set `team.flags.proactiveInvestigationPausedUntil`
- Burst mode: after a successful run, claim another pending investigation if wallclock budget remains and fewer than 3 were processed this tick
- Global concurrency guard via p-queue(concurrency=1)

**Agent loop** (refactor of `investigation-agent.ts`):
- System prompt with phase directives, trigger context, recalled memories, and hardcoded ≤600-token few-shot example
- `STEP:` tag parser: strip `<think>...</think>` blocks before scanning; write parsed phase to `loopState.currentPhase`
- Phase-to-schema mapper: `hypothesize↔plan`, `gather↔execute`, `challenge↔verify`, `report↔summarize`
- Tool registry filtered per phase (≤5 tools visible); challenge phase excludes the most-called gather tool
- Phase-transition compaction: replace completed-phase messages with a 3-bullet summary in the active context; retain raw in `loopState.phaseHistory`
- In-run tool result dedup via `Map<argsHash, result>` scoped to current run
- `stopWhen` budget enforcement: tool-call cap, token cap, wallclock cap, all checked after every step
- Qwen3 per-phase sampling: temperature and thinking-budget via `providerOptions` on every turn
- `parallel_tool_calls: false`

**Reader tools** (with compaction wrappers):
- `queryMetrics`: time-series over OTel metric names, returns percentile stats
- `searchPastInvestigations`: Mongo lookup on InvestigationMemory by fingerprint, service, symptom
- `getActiveAlerts`: currently firing alerts with state, threshold, last trigger
- `findSimilarErrors`: longer-window variant of searchLogs for recurrence detection
- Update existing `searchLogs`, `searchTraces`, `getTraceDetail`, `queryMetrics` compaction wrappers to new compact shapes

**Writer tools**:
- `createSavedSearch`: calls existing saved-search service; tags with systemUser + `createdByInvestigationId`
- `createDashboard`: calls existing dashboard service; builds tiles from the last 5 executed reader queries; creates "Investigations" folder lazily
- `createDraftAlert`: creates Alert with `state=DRAFT`; not model-facing for `updateInvestigationSummary`

**Post-loop writes**:
- On success: `generateObject` for structured finding → `updateInvestigationSummary` (internal) writes finding to Investigation, upserts InvestigationMemory (increment recurrenceCount, append to findings[], cap at 20), sets `status=resolved` (or `needs_review` if confidence low or schema retries exhausted)
- On failure: `status=failed`, `lastError` set; no InvestigationMemory written

**Adjacent task updates**:
- check-alerts: skip `state === AlertState.DRAFT`
- data-retention: prune InvestigationMemory records older than `memoryTTLDays`

### Acceptance criteria

- [ ] A `pending` Investigation is atomically claimed by the runner; a second concurrent claim attempt on the same document fails (returns null)
- [ ] The agent loop progresses through all four phases in order (hypothesize → gather → challenge → report) for a canned mock-LLM sequence
- [ ] `STEP:` tags inside `<think>` blocks are not treated as phase directives
- [ ] Each phase sees only its allowed tool subset; challenge phase does not include the most-called gather tool
- [ ] Phase-transition compaction replaces raw phase messages with a summary in the active context; raw messages are preserved in `loopState.phaseHistory`
- [ ] Identical tool calls within a run return the cached result without re-querying ClickHouse
- [ ] `stopWhen` halts the loop when `maxToolCalls` is reached before the report phase; investigation ends in `failed`
- [ ] `stopWhen` halts when `maxWallclockMs` is exceeded; investigation ends in `failed`
- [ ] On normal completion: a SavedSearch, Dashboard (with pre-filled tiles), and DRAFT Alert exist in Mongo tagged with systemUser and `createdByInvestigationId`; an InvestigationMemory record exists; Investigation status is `resolved`
- [ ] On low-confidence report: status is `needs_review`; no DRAFT Alert is created
- [ ] A second run for the same fingerprint increments `InvestigationMemory.recurrenceCount`; findings[] does not exceed 20 entries
- [ ] check-alerts task does not evaluate DRAFT alerts
- [ ] data-retention task prunes InvestigationMemory records older than configured TTL
- [ ] After `circuitBreaker.maxFailuresPerHour` failures for a team, that team's triage is paused until the cooldown expires
- [ ] A team exceeding `maxRunsPerTeamHour` is skipped by the runner for that tick

---

## Phase 4: Admin UI + User UI

**User stories**: 1–15

### What to build

All user-visible surfaces. Extend the `GET /investigations` and `GET /investigations/:id` endpoints to expose new fields, then build the frontend: platform admin config form, investigation list enhancements, investigation detail report section, and alert list draft state handling.

**API extensions**:
- `GET /investigations`: accept `?source=proactive` filter; return `source`, `fingerprint` (first 8 chars), `status`, `artifacts`, `attemptCount`, linked `InvestigationMemory.recurrenceCount`
- `GET /investigations/:id`: return full `artifacts` list, linked `InvestigationMemory` record (summary, confidence, rootCause, affected services, artifact links)

**Platform admin UI**:
- New "Proactive Investigation" section in the existing platform admin page
- Form fields bound to `ProactiveInvestigationConfigSchema`: enabled toggle, triage/runner cron, model name + base URL (API key shown as "stored in env — not editable here"), max runs per team per hour, reopen after hours, memory TTL days, budget defaults, anomaly sweep sub-form, Qwen sub-form (thinking toggle, per-phase temperature grid), circuit breaker settings
- Saves via `PATCH /platform/settings/proactive-investigation`

**Investigation list**:
- "Auto investigations" filter tab backed by `?source=proactive`
- Status badge (pending / active / resolved / needs_review / failed) with distinct colors
- Trigger source label (alert / anomaly)
- Fingerprint preview (first 8 chars of sha1)
- Recurrence count badge (hidden when 0)

**Investigation detail**:
- "Report" section above the messages thread, visible when `entryPoint.type === 'proactive'`
- Renders: summary, confidence level, root cause hypothesis, affected services, artifact links (saved search, dashboard, draft alert) as clickable chips

**Alert list**:
- DRAFT state badge on agent-created alerts
- "Promote" button on DRAFT alerts — calls existing alert update endpoint to flip `DRAFT → OK` (or `DISABLED` if user wants inactive)

### Acceptance criteria

- [ ] `GET /investigations?source=proactive` returns only proactive investigations; omitting the param returns all (existing behavior unchanged)
- [ ] `GET /investigations/:id` for a resolved proactive investigation returns the `artifacts` list and the linked `InvestigationMemory` fields
- [ ] Platform admin can save a config change via the admin form; a non-admin sees no access to the form
- [ ] API key field in the admin form is display-only and shows "stored in env — not editable here"
- [ ] Investigation list shows "Auto investigations" tab; selecting it filters to `source=proactive` investigations
- [ ] Each proactive investigation row shows status badge, trigger source, fingerprint preview, and recurrence count (recurrence count hidden when 0)
- [ ] Investigation detail "Report" section is visible for proactive investigations and hidden for all other investigation types
- [ ] Report section renders summary, confidence, root cause, affected services, and artifact links from the linked InvestigationMemory
- [ ] Alert list shows DRAFT badge on agent-created alerts
- [ ] Clicking "Promote" on a DRAFT alert flips it to OK (active); the alert subsequently appears in check-alerts evaluation
