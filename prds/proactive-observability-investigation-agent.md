# PRD: Proactive Observability Investigation Agent

## Problem Statement

HyperDX users receive alerts when things go wrong but must manually build the context needed to understand them: which services are affected, what the error signature looks like, whether this has happened before, and which queries to run next. This repetitive triage work happens every time an alert fires, including at 3am. Engineers spend 10–30 minutes assembling context that a scheduled agent could assemble while they sleep.

## Solution

A scheduled agent that automatically investigates firing alerts and detected anomalies, distills a structured finding, creates the saved searches / dashboards / draft alerts needed to monitor the pattern going forward, and records the outcome in a memory store so future runs can say "this is the fourth time this week, last resolved by deploy X." The feature ships as two scheduled tasks (cheap triage, expensive LLM runner), a 4-phase agent loop optimized for Qwen3 via the AI SDK, and a minimal read-only UI in v1.

## User Stories

1. As an on-call engineer, I want the system to automatically start investigating firing alerts so I have a distilled report waiting for me when I wake up.
2. As an on-call engineer, I want to see which services were affected and what the root cause hypothesis is so I can validate rather than discover.
3. As an on-call engineer, I want to know if this error has happened before and how it was resolved so I can apply proven remediation steps.
4. As an on-call engineer, I want an auto-created saved search for the error pattern so I can drill in without writing a query from scratch.
5. As an on-call engineer, I want an auto-created dashboard tile for the affected service's error rate so I can see the blast radius at a glance.
6. As an on-call engineer, I want draft alerts pre-configured for the detected pattern so I can promote them to production with one click.
7. As an on-call engineer, I want to see the investigation status (pending, active, resolved, needs_review, failed) so I know whether the agent finished or needs human help.
8. As an on-call engineer, I want an "Auto investigations" filter on the investigation list so I can find all proactively generated reports quickly.
9. As an on-call engineer, I want to see how many times this fingerprint has recurred so I can distinguish a new problem from a recurring one.
10. As a platform admin, I want to enable/disable the feature globally without a restart so I can respond to runaway costs immediately.
11. As a platform admin, I want to configure the model name, base URL, and per-investigation budget so I can control spending.
12. As a platform admin, I want to configure anomaly sweep thresholds (error rate multiplier, min absolute count, top K) so I can tune signal quality.
13. As a platform admin, I want a circuit breaker that pauses investigations for a team after repeated failures so runaway errors don't drain budget.
14. As a platform admin, I want memory TTL configuration so investigation history doesn't accumulate indefinitely.
15. As a platform admin, I want the API key stored in an env var (not the database) so secrets are not accessible via the admin UI.
16. As the system, I want to detect anomalies via a ClickHouse sweep (no LLM) so unknown unknowns surface without requiring an alert to be pre-configured.
17. As the system, I want to deduplicate investigations using a deterministic fingerprint so the same problem doesn't generate multiple concurrent investigations.
18. As the system, I want a lease mechanism with expiry so a crashed runner does not permanently block an investigation.
19. As the system, I want to write InvestigationMemory only on successful runs so failed runs don't corrupt the recall store.
20. As the system, I want draft alerts to be skipped by the check-alerts evaluator so agent-created alerts don't fire before a human reviews them.

## Implementation Decisions

### Task architecture
Two scheduled tasks registered in the existing TaskName enum: `PROACTIVE_INVESTIGATION_TRIAGE` (every 2 minutes, no LLM, Mongo + ClickHouse only) and `PROACTIVE_INVESTIGATION_RUN` (every 5 minutes, LLM-driven, single replica). Both implement the existing HdxTask interface and are registered via the existing createTask() factory switch.

### Investigation model extensions
Extend the existing Investigation Mongoose schema (do not create a new collection). New fields are all optional so existing documents are unaffected:
- Status enum extended: `pending | active | resolved | failed | ignored | needs_review | exported`
- `entryPoint.type` extended: add `'proactive'` alongside existing `trace | alert | standalone`
- New top-level fields: `source`, `sourceRef`, `fingerprint`, `reopenedFrom`, `resolvedBy`, `leaseExpiresAt`, `attemptCount`, `lastError`, `artifacts` (savedSearchIds, dashboardIds, draftAlertIds), `budget` (maxToolCalls, maxTokens, maxWallclockMs, consumedToolCalls, consumedTokens, startedAt)
- New indexes: `{ team, status, createdAt }`, `{ team, fingerprint, status }`, `{ status, leaseExpiresAt }`, `{ team, 'entryPoint.type', createdAt }`

### InvestigationMemory model extension
Add `fingerprint: string` field and index `{ teamId, fingerprint, resolvedAt }`. On successful investigation, upsert by `(teamId, fingerprint)`: increment recurrenceCount and append to findings[] (cap at 20, drop oldest). No backfill of existing records — they simply don't match future fingerprints until they age out. TTL enforced by extending the existing data-retention task.

### Alert model extension
Add `DRAFT` to the AlertState enum. check-alerts task gains one skip condition: `state === AlertState.DRAFT`. Agent-created draft alerts record the system user as createdBy.

### System user
Bootstrap a singleton `proactive-agent@system` user (isSystem: true, team-less) in the existing setup-defaults reconciliation path. Used as createdBy on all proactive investigations and agent-created artifacts. Avoids making createdBy nullable.

### Configuration
`ProactiveInvestigationConfigSchema` (Zod, in packages/common-utils/src/types/) stored as a PlatformSetting document keyed `'proactiveInvestigation'`. Loader in packages/api/src/controllers/proactiveInvestigationConfig.ts wraps Mongo read in 30-second in-process TTL cache; cache invalidated immediately on write. Secrets (model API key) live only in env vars. On first boot, if no setting exists, insert defaults with `enabled: false`.

### Triage task public interface
`runTriageTick(teamId)` → void. Internally: reads config, checks circuit breaker flag on team, enumerates alert candidates (Alert.state === ALERT with no active investigation), runs ClickHouse anomaly sweep (one aggregated query per team), filters by threshold, computes fingerprints, deduplicates, inserts pending investigations, runs lease reaper. Fully idempotent via fingerprint dedup.

### Fingerprint algorithm
Pure function in packages/api/src/controllers/fingerprint.ts. For alert source: `sha1(teamId|alert|alertId)`. For anomaly sweep: `sha1(teamId|anomaly|serviceName|<normalized-signature>)` where signature is the most specific available field (exceptionType → errorKind → httpStatus:operation → normalized top error message → 'unknown'). Normalization strips UUIDs, numbers, collapses whitespace.

### Runner task public interface
`runRunnerTick()` → void. Internally: reads config, checks per-team rate limit (maxRunsPerTeamHour), atomically claims one pending investigation via findOneAndUpdate with leaseExpiresAt, loads memory recalls + alert/anomaly detail, runs agent loop, writes results, optionally bursts (up to 3 claims per tick if wallclock budget remains). Global concurrency guard via p-queue(concurrency=1).

### Agent loop
Single streamText conversation per investigation. Phase directives in system prompt; model emits `STEP: <phase>` at top of each response. Loop controller parses STEP tag from visible output only (strip `<think>` blocks first — Qwen3 thinking mode emits these before visible content). Tool registry filtered to phase-appropriate subset (max 5 tools visible per turn, below Qwen hallucination cliff). In-run tool result dedup via Map<argsHash, result> scoped to current run. Phase-transition compaction replaces raw phase messages with a 3-bullet summary before the next provider call; raw messages retained in loopState.phaseHistory.

### Phase mapping
| Prompt phase | Schema phase | Purpose |
|---|---|---|
| hypothesize | plan | 2–4 ranked hypotheses after first signal look |
| gather | execute | Reader tools to test hypotheses |
| challenge | verify | Actively seek contradicting evidence; thinking on |
| report | summarize | Structured finding + artifact creation; thinking on |

### Tool gating per phase
- hypothesize: searchPastInvestigations, getActiveAlerts, searchLogs (10-row peek), queryMetrics (1-hour cap)
- gather: searchLogs, searchTraces, getTraceDetail, queryMetrics, findSimilarErrors
- challenge: same as gather minus the single most-called tool from the gather phase (hard-filtered, not a hint)
- report: createSavedSearch, createDashboard, createDraftAlert

### Writer tools
- createSavedSearch: calls existing saved-search service, tags with systemUser._id and createdByInvestigationId
- createDashboard: calls existing dashboard service, builds tiles from the last 5 executed queries per reader tool, creates "Investigations" folder lazily
- createDraftAlert: creates Alert with state=DRAFT, skips evaluation
- updateInvestigationSummary: NOT model-facing; loop controller calls this after generateObject succeeds to write finding and upsert InvestigationMemory

### Reader tool compaction
Every reader tool wraps raw ClickHouse results in a compactor before the agent sees them. Text capped at 500 chars/row, topN capped at 10, histogram buckets capped at 20. This is mandatory for Qwen3-32B's practical context depth.

### Sampling per phase
Temperature varies per phase (0.3 / 0.1 / 0.2 / 0.0). Qwen3 thinking mode enabled for challenge and report phases with token budgets (2048 / 3072 respectively). parallel_tool_calls disabled — investigation phases are sequential.

### stopWhen condition
Budget check evaluated after every step: (phase=summarize AND reportObjectWritten) OR toolCalls≥max OR tokens≥max OR wallclock≥max.

### Few-shot example
System prompt includes one hardcoded ≤600-token example trace showing all four phases with representative tool calls. Not generated at runtime. Required for Qwen3 phase adherence.

### API surface
- `PATCH /platform/settings/proactive-investigation` — guarded by platform-admin role; invalidates config cache
- `GET /investigations` — extend existing endpoint: add `?source=proactive` filter, return new fields (source, fingerprint, artifacts, attemptCount)
- `GET /investigations/:id` — extend existing endpoint: return artifacts list and linked InvestigationMemory

### UI (v1 — read-only)
- Investigation list: "Auto investigations" filter tab backed by `entryPoint.type === 'proactive'`; status badge; trigger label (alert vs anomaly); fingerprint preview (8 chars); recurrence count from linked memory
- Investigation detail: "Report" section above messages rendering InvestigationMemory (summary, confidence, rootCause, affected services, artifact links)
- Alert list: show DRAFT state badge; promote button flips DRAFT → OK
- Admin page: new "Proactive Investigation" section with form fields for all ProactiveInvestigationConfig fields; API key field is display-only ("stored in env")

### Migration
migrate-mongo migration for new Investigation indexes and default PlatformSetting insert. No ClickHouse migration. Mongoose createIndexes() handles index creation on boot.

## Testing Decisions

Unit tests (Jest, packages/api/src/.../__tests__/) cover pure functions and isolated logic:
- Fingerprint hash stability across all fallback branches
- Dedup: same fingerprint → skip; stale resolved + same fingerprint → reopen with reopenedFrom
- Mongo claim atomicity: concurrent findOneAndUpdate against in-memory Mongo → exactly one succeeds
- Tool compaction wrappers: known raw ClickHouse shapes → expected compact shapes
- Step-tag parser: malformed, missing, ambiguous tags; tag inside <think> block (must not be treated as directive)
- Tool-gate filter: each phase returns only the allowed subset; challenge excludes most-called gather tool
- Config loader: Mongo miss returns schema defaults; Mongo hit overrides; cache TTL expiry picks up changes
- Circuit breaker: rolling window accounting

Integration tests (make dev-int, real Mongo + ClickHouse, mocked AI SDK model) cover multi-component flows:
- Triage end-to-end: seed firing alerts + anomalous logs → run tick → assert pending investigations → run second tick → assert dedup → mark one resolved with past timestamp → run tick → assert reopen with reopenedFrom
- Runner end-to-end: seed pending investigation → mock AI SDK to return canned 4-phase tool-calling sequence → run tick → assert: claim succeeded, phases in order, artifacts created (real Mongo rows for saved search + dashboard + draft alert), memory written, status = resolved
- Lease expiry: seed active investigation with past leaseExpiresAt → run triage reaper → assert pending + attemptCount incremented → repeat until failed
- Budget exhaustion: seed investigation with maxToolCalls=2 → mock LLM to attempt 3 calls → assert third rejected and status = failed
- Circuit breaker: seed 5 failed investigations within window → run triage → assert team skipped until cooldown

Follow the existing integration test pattern: make dev-int FILE=proactiveInvestigation to run these.

Smoke test: packages/api dev:smoke script, gated behind PROACTIVE_INVESTIGATION_SMOKE=true env var, runs one real end-to-end investigation against live Qwen deployment. Not in CI.

## Out of Scope

- Remediation suggestions (requires deploy-tracking and runbook integrations)
- Per-team config overrides (v1.1)
- Slack / webhook notifications when investigation completes (v1.1)
- Embedding-based memory retrieval (v2 if fingerprint recall precision is the bottleneck)
- Latency / saturation / throughput anomaly signals (v2 — v1 covers error-count deltas only)
- Investigation lifecycle UI buttons: resolve, ignore, reopen (v1.1)
- Bulk triage panel (v1.1)
- Multi-replica task runner (current deployment shape is single replica; Mongo atomic claim already handles coordination if this changes)
- Transport-layer changes, WAF/ingress modifications

## Further Notes

- The deployment target is Qwen3-32B served via an OpenAI-compatible endpoint (DashScope context caching or self-hosted vLLM with --enable-prefix-caching). The AI SDK providerOptions must pass temperature and thinking-budget settings on every turn — not as global model config.
- PROACTIVE_INVESTIGATION TaskName already exists in the tasks/types.ts enum (uncommitted diff). This PRD specifies splitting it into PROACTIVE_INVESTIGATION_TRIAGE and PROACTIVE_INVESTIGATION_RUN.
- The investigationMemory.ts model already exists at packages/api/src/models/investigationMemory.ts. Only the fingerprint field and its index need to be added.
- loopState uses schema phases (plan/execute/verify/summarize/complete). Agent prompt uses cognitive phases (hypothesize/gather/challenge/report). The loop controller in investigation-agent.ts maps between them.
- Rollout is 8 independently revertable phases: schema → triage task → agent loop refactor → runner task → writer tools → UI → staging enable → production opt-in.

## Decisions Log

```
Q: Who are the actors?
A: Platform admins (configure), on-call SREs (read auto-investigation reports), end users (consume artifacts).
Why: Design doc sections 11.1-11.2 define exactly these two surfaces.

Q: What is the primary happy path?
A: Alert fires → triage inserts pending Investigation → runner claims → 4-phase agent loop → artifacts written → status = resolved.
Why: Architecture overview in design doc section 3.

Q: How should we handle duplicate signals for the same issue?
A: Deterministic sha1 fingerprint per candidate, dedup via Mongo index on (team, fingerprint, status∈[pending,active]). Resolved + same fingerprint after reopenAfterHours → new investigation with reopenedFrom pointer.
Why: Section 9 fingerprint algorithm + section 5.1 step 6.

Q: What model/LLM integration pattern to follow?
A: AI SDK streamText with single multi-turn conversation. Phase directives in system prompt, STEP: tag parsed from visible output (strip <think> blocks). Tool registry gated per phase.
Why: Section 7 — single-loop design for prefix-cache reuse and natural back-arrows.

Q: How does multi-turn context stay under model limits?
A: Phase-transition compaction: replace raw phase messages with a 3-bullet summary in active context after each STEP: tag. Raw messages retained in loopState.phaseHistory.
Why: Section 7.7 — Qwen3-32B attention degrades beyond ~20k tokens.

Q: Where does config live?
A: PlatformSetting Mongo doc keyed 'proactiveInvestigation', read via cached loader (30s TTL). Secrets stay in env vars.
Why: Section 4.4 — explicit separation of config vs secrets.

Q: How do we avoid runaway LLM costs?
A: Per-investigation budget (maxToolCalls=12, maxTokens=30k, maxWallclockMs=240s) in stopWhen. Per-team rate limit (20/hour). Circuit breaker (5 failures/hour → 1h cooldown). Global kill switch.
Why: Section 13 guardrails table.

Q: How do we handle lease expiry / crashes mid-run?
A: leaseExpiresAt on active investigations. Triage tick's lease reaper flips back to pending. attemptCount > 3 → failed.
Why: Section 5.1 step 8 + section 6.3.

Q: What testing patterns exist in the repo?
A: Jest unit tests in __tests__/ dirs; make dev-int for integration tests (real Mongo+ClickHouse, mocked LLM).
Why: AGENTS.md testing section + codebase exploration.

Q: How should draft alerts avoid being evaluated?
A: Add DRAFT to AlertState enum; check-alerts task skips state === AlertState.DRAFT.
Why: Section 4.3 + section 15.

Q: What is the data migration strategy?
A: All new Investigation fields optional (no backfill). InvestigationMemory.fingerprint added (old records get no value). Mongoose createIndexes() on boot.
Why: Section 15 — no breaking changes.

Q: What is out of scope for v1?
A: Remediation, per-team overrides, Slack/webhooks, embedding memory, latency signals, lifecycle buttons.
Why: Section 16 open items + section 11.3 deferred list.
```
