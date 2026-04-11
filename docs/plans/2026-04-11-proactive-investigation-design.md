# Proactive Observability Investigation — Design

- **Date:** 2026-04-11
- **Status:** Approved for implementation planning
- **Scope:** `packages/api` (primary), `packages/app` (minimal v1 UI), `packages/common-utils` (Zod schemas)
- **Deployment target:** Qwen model served via an OpenAI-compatible endpoint (DashScope context caching or self-hosted vLLM with `--enable-prefix-caching`)

## 1. Problem and motivation

HyperDX users already receive alerts when things go wrong. What they do not get automatically is context: a distilled "here is the error signature, here are the affected services, here is what has happened before, here are the artifacts you need to dig in further." Building that context is repetitive work that a scheduled agent can do while users sleep.

The feature adds a scheduled agent that, when triggered by a firing alert or an anomaly detected by a cheap sweep, investigates the signal, writes a distilled finding, creates the saved searches / dashboards / draft alerts needed to monitor the pattern going forward, and records the outcome in a memory store so future runs can say "this is the fourth time this week, last resolved by deploy X."

## 2. Decision summary

| Decision | Choice |
|---|---|
| Trigger model | Hybrid: alert-attached primary, anomaly-sweep fallback for unknown unknowns |
| Output artifacts | Full forensic package: distilled report + saved search + dashboard tile + draft alert |
| Lifecycle | Investigations have explicit states (`pending`, `active`, `resolved`, `failed`, `ignored`, `needs_review`, `exported`) with human toggles deferred to v1.1 |
| Fan-out | Two scheduled tasks: cheap triage (no LLM), expensive runner (LLM) |
| Investigation scope | "What is happening" + "why" + "has it happened before" (no remediation suggestions) |
| Agent loop | Single `streamText` call with phase directives in the system prompt (not a 4-step LLM state machine), Qwen-optimized |
| Infra | Mongo-native coordination, no Redis dependency |
| Config | PlatformSetting-backed, editable from admin UI, no env var knobs (except secrets) |
| UI v1 | List view + status badges + report view; lifecycle toggle buttons ship in v1.1 |

## 3. Architecture overview

Two scheduled tasks registered through the existing `TaskName` enum and cron runner.

```
PROACTIVE_INVESTIGATION_TRIAGE   (cron every 2m, no LLM)
    discovers candidates -> dedupes by fingerprint -> inserts pending investigations

PROACTIVE_INVESTIGATION_RUN      (cron every 5m, LLM-driven, single task-runner replica)
    claims one pending -> runs agent loop -> writes artifacts + memory -> flips status
```

Data flow:

```
Alerts (firing)         \
                         -->  Triage task  --> Investigation docs (pending) --\
ClickHouse anomaly sweep /                                                    |
                                                                              v
Runner task  <-- Investigation docs (pending, FIFO by createdAt) -- Mongo atomic claim
    |
    |  load memory recalls, tool registry, config
    v
 Agent loop (single streamText)
    hypothesize -> gather -> challenge -> report
    |
    v
Writes:  InvestigationMemory, SavedSearch(es), Dashboard(es), Alert(state=DRAFT)
         Investigation.status = resolved | needs_review | failed
```

Back-pressure is implicit in the `pending` queue: if runner cannot keep up, triage keeps inserting and the queue is visible in the UI as a backlog.

## 4. Data model changes

All models already exist in `packages/api/src/models`. Changes extend existing schemas rather than creating parallel structures.

### 4.1 `Investigation` (extend)

Existing fields: `team`, `createdBy`, `title`, `status`, `entryPoint`, `messages`, `summary`, `sharedWith`, `exports`, `loopState`.

**Status enum — extend from `active | resolved | exported` to:**

```
pending        (triage inserted; runner has not claimed)
active         (runner is executing OR user is working on it — reused existing value)
resolved       (agent finished with usable output OR user marked done)
failed         (budget exhausted, provider error, or too many lease re-queues)
ignored        (user dismissed; not acted on)
needs_review   (agent finished but confidence is low; human should look)
exported       (existing; user-exported investigation)
```

**`entryPoint.type` enum — extend from `trace | alert | standalone` to add `proactive`.**

All investigations created by triage set `entryPoint.type = 'proactive'`. The existing `'alert'` value stays reserved for user-initiated "investigate this alert" flows. `entryPoint.alertId` is still populated for proactive alert-sourced investigations (to link back to the triggering alert).

**New top-level fields:**

```ts
{
  // Provenance
  source?: 'alert' | 'anomaly_sweep' | 'manual'; // default 'manual' at read time
  sourceRef?: {
    alertId?: ObjectId;
    serviceName?: string;
    metricName?: string;
  };
  fingerprint?: string;           // sha1, see section 9
  reopenedFrom?: ObjectId;        // prior investigation for recurrence tracking
  resolvedBy?: 'agent' | 'user';

  // Runner coordination
  leaseExpiresAt?: Date;
  attemptCount: number;           // default 0
  lastError?: string;

  // Artifacts produced by the report phase
  artifacts?: {
    savedSearchIds: ObjectId[];
    dashboardIds: ObjectId[];
    draftAlertIds: ObjectId[];
  };

  // Per-run budget accounting (populated on claim from config defaults)
  budget?: {
    maxToolCalls: number;
    maxTokens: number;
    maxWallclockMs: number;
    consumedToolCalls: number;
    consumedTokens: number;
    startedAt?: Date;
  };
}
```

**`loopState` — reuse unchanged.** The existing phase enum `plan | execute | verify | summarize | complete` is the schema-facing vocabulary. The agent prompt uses the cleaner cognitive frames `hypothesize | gather | challenge | report`; a small mapper (`packages/api/src/controllers/investigation-agent.ts`) translates between the two. `phaseHistory[]` is appended after each model turn by the step-tag parser.

**New indexes:**

```
{ team: 1, status: 1, createdAt: 1 }       // runner claim query
{ team: 1, fingerprint: 1, status: 1 }     // triage dedup
{ status: 1, leaseExpiresAt: 1 }           // stale-lease reaper
{ team: 1, 'entryPoint.type': 1, createdAt: -1 }  // UI filter for "Auto investigations"
```

### 4.2 `InvestigationMemory` (extend)

Existing fields: `teamId` (String, not ObjectId — preserved), `investigationId`, `findings[]`, `artifactsCreated[]`, `resolvedAt`, `recurrenceCount`, `baselineMetrics`, `triggerType`, `summary`, `confidence`.

**New field:**

```ts
{
  fingerprint: string;            // matches Investigation.fingerprint for exact recurrence lookup
}
```

**Insert semantics:** on successful investigation (status `resolved` or `needs_review`), check for an existing `InvestigationMemory` with the same `(teamId, fingerprint)`. If present, increment its `recurrenceCount` and append a new entry to its `findings[]` (cap findings length at 20, dropping oldest). If absent, insert a fresh record. This gives "4th time this week" narratives without a second collection.

**`triggerType` mapping:** `source='alert'` stores as existing `'alert'`, `source='anomaly_sweep'` stores as existing `'health_scan'`. No enum change.

**New index:** `{ teamId: 1, fingerprint: 1, resolvedAt: -1 }`.

**TTL:** configurable via PlatformSetting `memoryTTLDays` (default 90). Enforced by extending the existing `data-retention` task to prune `InvestigationMemory` records older than the configured TTL.

### 4.3 `Alert` (extend)

**Extend `AlertState` enum** with one new value: `DRAFT`.

Draft alerts are not evaluated — the `check-alerts` task is updated to skip `state: AlertState.DRAFT`. Humans promote a draft alert from the UI; promotion flips `DRAFT → OK` (or `DISABLED` if the user wants to ship a promoted-but-inactive alert).

Agent-created alerts record the system user (see 4.5) as `createdBy`.

### 4.4 `PlatformSetting` (new well-known key)

Single setting document:

```
{
  key: "proactiveInvestigation",
  value: { ...ProactiveInvestigationConfig... },
  updatedBy: <platform admin user>
}
```

Full shape — see Section 12 for the Zod schema and defaults.

**Loader pattern:** `getProactiveInvestigationConfig()` in `packages/api/src/controllers/proactiveInvestigationConfig.ts` wraps the Mongo read in a 30-second in-process TTL cache. Triage and runner call it at tick start. Admin-UI writes via a new REST endpoint (`PATCH /platform/settings/proactive-investigation`) guarded by the existing platform-admin role. On write, the cache entry is invalidated immediately in the writing process; other API replicas pick up the change within 30 seconds without a restart.

**Secrets are NOT in Mongo.** The model provider API key is an env var (e.g. `OPENAI_API_KEY` or a provider-specific variant, reusing whatever the existing OpenAI-compatible provider wiring already consumes). Mongo holds configuration; env holds secrets.

### 4.5 System user (`proactive-agent@system`)

Created during application bootstrap by extending the existing default-sources reconciliation path (recent `setupDefaults` commit for reference). Singleton, team-less, flagged with `isSystem: true`. Used as `createdBy` on proactive investigations and agent-created artifacts (saved searches, dashboards, draft alerts). This avoids making `createdBy` nullable across the codebase.

## 5. Triage task — `PROACTIVE_INVESTIGATION_TRIAGE`

**Cadence:** every 2 minutes (configurable via `triageCron`).
**LLM calls:** none.
**Infra touched per tick:** Mongo, ClickHouse (one aggregated query per team for the anomaly sweep).

### 5.1 Tick procedure (per team)

1. **Read config.** If `enabled: false`, return. If per-team circuit breaker is active (`team.flags.proactiveInvestigationPausedUntil` in the future), skip this team.
2. **Enumerate alert candidates.** Query `Alert` where `state === AlertState.ALERT` and no existing `Investigation` exists with `entryPoint.alertId` equal to this alert and `status in ['pending', 'active']`.
3. **Enumerate anomaly-sweep candidates.** Issue one ClickHouse query per team computing top-K services by error-count delta vs a trailing 6-hour baseline, filtered by the team's ClickHouse source config. The query returns, per candidate:
   - `serviceName`
   - `errorCount`, `baselineErrorCount`, `ratio`
   - `exceptionType` (if present on spans or logs — OTel `exception.type` attribute)
   - `errorKind` (if present — OTel `error.kind` or similar structured attribute)
   - `topHttpStatusBucket` and `topOperationName` (for HTTP services)
   - `topErrorMessage` (first line of the most-frequent error message in the window)
4. **Filter by anomaly threshold.** Keep candidates where `ratio >= errorRateMultiplier` AND `errorCount >= minAbsoluteCount`. Trim to `topK`.
5. **Compute fingerprint per candidate.** See Section 9 for the algorithm.
6. **Dedup.** For each candidate, query `Investigation` by `{ team, fingerprint, status: { $in: ['pending', 'active'] } }`. If a match exists, skip. If a `resolved` or `needs_review` investigation exists with the same fingerprint AND `resolvedAt` older than `reopenAfterHours`, insert a new investigation with `reopenedFrom = priorInvestigation._id`.
7. **Insert `pending` investigations** with:
   - `team`, `createdBy = systemUser._id`, `title = <auto-generated from signal>`
   - `entryPoint.type = 'proactive'`, `entryPoint.alertId` set for alert candidates
   - `status = 'pending'`, `source`, `sourceRef`, `fingerprint`, `attemptCount = 0`
   - `budget` copied from `budgetDefaults` in config
8. **Lease reaper.** Before finishing the tick, run one cleanup pass: `findOneAndUpdate` all investigations with `status: 'active'` and `leaseExpiresAt < now`, flipping them back to `pending` and incrementing `attemptCount`. If `attemptCount > 3`, transition to `failed` with `lastError = 'lease_expired_max_attempts'`.

### 5.2 Idempotency

Triage is fully idempotent via the fingerprint-based dedup in step 6. Running it twice back-to-back does nothing on the second run. A crash mid-tick leaves partial `pending` inserts; the next tick picks up where the previous one left off without duplication.

## 6. Runner task — `PROACTIVE_INVESTIGATION_RUN`

**Cadence:** every 5 minutes (configurable via `runnerCron`).
**LLM calls:** one `streamText` conversation per investigation, multi-turn, with tool calls.
**Infra touched per tick:** Mongo, ClickHouse (via agent tools), LLM provider.

### 6.1 Deployment assumption

The task runner runs as a single replica (same deployment shape as the existing `check-alerts` / `check-inactive-users` / `data-retention` tasks). This guarantees in-process exclusivity for the runner tick. The Mongo atomic claim is defense in depth for the rare case of an overlapping tick from the same process or a bad deployment shape.

### 6.2 Tick procedure

1. **Read config.** If `enabled: false`, return.
2. **Rate-limit check per team.** Count investigations transitioned to `active` in the last hour per team; skip teams that exceed `maxRunsPerTeamHour`.
3. **Claim** one pending investigation atomically:

   ```ts
   const claimed = await Investigation.findOneAndUpdate(
     { status: 'pending' },
     {
       $set: {
         status: 'active',
         leaseExpiresAt: new Date(Date.now() + LEASE_MS),
         'budget.startedAt': new Date(),
       },
       $inc: { attemptCount: 1 },
     },
     { sort: { createdAt: 1 }, new: true },
   );
   ```

   Lease duration = `maxWallclockMs + 60_000` (1-minute safety margin). If `claimed === null`, the queue is empty — the tick returns immediately.
4. **Load context.**
   - Fetch memory recalls via `searchPastInvestigations`: exact fingerprint match and recent memories for the affected services (last 7 days).
   - Fetch the alert or synthetic anomaly detail.
   - Fetch the team's ClickHouse source config (for tool execution).
5. **Run the agent loop** (Section 7). Respect the per-investigation budget.
6. **Write results.**
   - On normal completion: write `InvestigationMemory`, flip `status` to `resolved` (or `needs_review` if the report phase reported low confidence or the `generateObject` schema validation retries were exhausted).
   - On error / budget exhaustion: flip `status` to `failed`, set `lastError`. Do not write `InvestigationMemory` on failure — only successful investigations teach the system.
   - Append the final `loopState.phaseHistory` entries.
7. **Burst mode.** If the wallclock tick budget still has more than 1 minute remaining AND total-processed this tick is less than 3 AND another pending investigation exists, loop back to step 2. Otherwise return.
8. **Global concurrency guard.** Wrap the entire tick body in `p-queue` with concurrency=1 (the task runner already uses `p-queue`). Overlapping ticks are serialized.

### 6.3 Failure handling

- **Claim attempt count cap:** after `attemptCount > 3`, the lease reaper in triage marks the investigation `failed`. Runner never sees it again.
- **Circuit breaker per team:** if more than `circuitBreaker.maxFailuresPerHour` investigations on the same team transition to `failed` within a rolling hour, set `team.flags.proactiveInvestigationPausedUntil = now + cooldownMs`. Triage respects this flag and skips the team until it expires.
- **Global kill switch:** `PlatformSetting.value.enabled = false` causes both tasks to return immediately on the next tick. Changes take effect within 30 seconds via the cached config loader.

## 7. Agent loop — Qwen-optimized

One `streamText` call per investigation, with tools and `stopWhen`. The agent self-paces through four prompt-declared phases by emitting a `STEP:` tag at the top of each response. A thin wrapper parses the tag, writes it to `loopState.currentPhase`, and filters the tool registry to only the phase-appropriate subset on the next provider turn.

**Why single-loop:** prefix-cache reuse (the conversation grows in one context, the provider's KV cache hits on every continuation), back-arrow support (the model can naturally return to `gather` mid-`challenge` if new evidence demands it), no sunk-cost phase boundaries, and the reasoning-mode benefit of Qwen3 captures the verify-step epistemic pressure without paying for four separate LLM calls.

### 7.1 Phase mapping (prompt-facing to schema-facing)

| Prompt phase (what the model sees) | Schema phase (stored in `loopState.currentPhase`) | Purpose |
|---|---|---|
| `hypothesize` | `plan` | State 2–4 hypotheses AFTER a first look at the signal, ranked by likelihood × impact |
| `gather` | `execute` | Call reader tools to test each hypothesis |
| `challenge` | `verify` | Actively look for evidence contradicting the top hypothesis; reasoning-mode on |
| `report` | `summarize` | Produce structured final finding and create artifacts; reasoning-mode on |

### 7.2 System prompt skeleton

```
You are an observability investigation agent for HyperDX.

## Context
Trigger: {trigger description}
Time window: {start} to {end}
Team: {teamId}
Prior investigations on this exact fingerprint: {recalled memories, 3 most recent}
Prior investigations on affected services: {recalled memories, 3 most recent}

## Your 4-step procedure (track your current step at the start of every response)
1. HYPOTHESIZE — State 2 to 4 hypotheses. Do this AFTER a first look at signals, not before. Rank by likelihood times impact.
2. GATHER — Call reader tools to test each hypothesis. Stop when confident.
3. CHALLENGE — Actively look for evidence that CONTRADICTS your top hypothesis. Use different tools or different time windows than in GATHER.
4. REPORT — Produce the final structured finding and create artifacts.

## Output format
Start every response with a line: "STEP: <step-name>" where step-name is one of: hypothesize, gather, challenge, report.
After that line, either call tools or produce the final report object.

## Hard constraints
- Max tool calls per phase: HYPOTHESIZE ≤ 2, GATHER ≤ 6, CHALLENGE ≤ 3, REPORT ≤ 2 (12 total).
- Do not create artifacts (saved searches, dashboards, alerts) until STEP 4.
- In CHALLENGE, you will see a different tool set than GATHER — use it. Do not ask for tools not in your current list.
- If your confidence is low after CHALLENGE, still produce a report but mark confidence as "low" and do not create a draft alert.

## Example of a well-run investigation trace
{one short compact tool-call trace from a seeded example}
```

### 7.3 Tool gating by phase

Only the tools relevant to the current phase are exposed in any given provider call. The registry has four subsets; after the step-tag parser writes `loopState.currentPhase`, the next turn's tool list is filtered.

| Step | Allowed tools |
|---|---|
| `hypothesize` | `searchPastInvestigations`, `getActiveAlerts`, `searchLogs` (peek mode, 10-row cap), `queryMetrics` (peek mode, 1-hour window cap) |
| `gather` | `searchLogs`, `searchTraces`, `getTraceDetail`, `queryMetrics`, `findSimilarErrors` |
| `challenge` | Same as `gather` **minus** the single most-called tool from that investigation's gather phase (tracked by the loop wrapper's call-count map). Hard-filtered from the tool registry — not a hint. If gather used only one tool, exclude it entirely and the agent must use a different approach. |
| `report` | `createSavedSearch`, `createDashboard`, `createDraftAlert` |

Max 5 tools visible per step. Below Qwen's 6–8 tool hallucination cliff.

### 7.4 Sampling per phase

Set via AI SDK per-call via `providerOptions` (not a global model setting — must be passed on every turn):

| Phase | Temperature | Qwen3 thinking mode | Thinking token budget |
|---|---|---|---|
| `hypothesize` | 0.3 | off | — |
| `gather` | 0.1 | off | — |
| `challenge` | 0.2 | on | 2 048 |
| `report` | 0.0 | on, then `generateObject` with Zod for the final finding | 3 072 |

Thinking budgets cap the hidden `<think>` block. Without them, a single challenge turn can consume 5–10k tokens — half the 30k total budget. Budgets are configurable via `qwen.thinkingBudgetPerPhase` in `ProactiveInvestigationConfigSchema` (see Section 12).

**Parallel tool calls:** disabled (`parallel_tool_calls: false` in provider options). Investigation phases are sequential by design; parallel calls would allow gather-phase tool results to interleave unpredictably and complicate the call-count tracker used for challenge-phase exclusion.

### 7.5 Tool result compaction

Every reader tool is wrapped in a compactor that transforms raw ClickHouse results into structured summaries before the agent sees them. This is critical for Qwen3-32B's practical context depth.

| Tool | Compacted output shape |
|---|---|
| `searchLogs` | `{ totalMatched, topN: [{ timestamp, severity, body }], errorCategoryCounts, timeHistogram }` |
| `searchTraces` | `{ totalMatched, slowestN, errorN, serviceBreakdown }` |
| `queryMetrics` | `{ series: [[ts, value], ...], min, max, p50, p95, p99, slope }` |
| `getTraceDetail` | Full trace tree but per-span attributes truncated to known interesting keys |
| `findSimilarErrors` | Error messages clustered, top N with occurrence counts and first/last seen |
| `searchPastInvestigations` | `{ memories: [{ summary, confidence, rootCause, recurrenceCount, resolvedAt }] }` |
| `getActiveAlerts` | `[{ id, name, state, threshold, lastTriggeredAt }]` |

Hard caps: `topN` defaults to 10; sample content text capped at 500 chars per row; histogram buckets capped at 20.

### 7.6 STEP tag parsing — thinking mode interaction

When Qwen3 thinking is enabled, the model emits `<think>...</think>` before visible output. The step-tag parser **must parse `STEP:` from the visible output only** — strip `<think>` blocks first. Parsing from the raw stream will misfire on `STEP:` mentions inside the reasoning trace.

Implementation: in the AI SDK `onChunk` / `onStepFinish` callback, strip content matching `/^<think>[\s\S]*?<\/think>/` before scanning for the `STEP:` prefix. The thinking block is still forwarded to `loopState.phaseHistory` for debugging but never treated as directive output.

### 7.7 Multi-turn context trimming

As the conversation grows across 12 tool calls, compacted tool results accumulate in the message history. Qwen3-32B's practical attention degrades beyond ~20k tokens of history. Strategy: **phase-transition compaction.**

After the loop wrapper detects a phase change (new `STEP:` tag), it:
1. Collects all assistant + tool messages from the completed phase.
2. Synthesises a single `assistant` summary message: `"[Phase: gather — complete. Tools called: X, Y, Z. Key findings: {3-bullet summary}]"`.
3. Replaces the raw phase messages with this single summary in the message array passed to the next provider call.

Original messages are retained in `loopState.phaseHistory` for storage; only the active provider context is trimmed. This keeps the live context under ~8k tokens regardless of how many tool calls occurred.

### 7.8 Few-shot example requirement

The system prompt skeleton (section 7.2) contains `{one short compact tool-call trace from a seeded example}`. **This is not optional.** For Qwen3, a concrete few-shot trace is the highest-impact single intervention for phase adherence and tool-calling reliability.

The example must be hardcoded (not generated at runtime) and show:
- A `STEP: hypothesize` turn with one `searchPastInvestigations` call and 3 ranked hypotheses.
- A `STEP: gather` turn with 2–3 tool calls testing different hypotheses.
- A `STEP: challenge` turn using a different tool than any used in gather.
- A `STEP: report` turn producing the structured finding object directly.

Total example length: ≤ 600 tokens. Exceeding this negates the compaction work done elsewhere.

### 7.9 `stopWhen` definition

The `streamText` call uses `stopWhen` to terminate the stream. Condition:

```ts
stopWhen: ({ steps }) => {
  const phase = loopState.currentPhase;
  const totalCalls = loopState.consumedToolCalls;
  return (
    (phase === 'summarize' && reportObjectWritten) || // normal completion
    totalCalls >= config.budgetDefaults.maxToolCalls || // tool cap
    tokensSoFar >= config.budgetDefaults.maxTokens || // token cap
    Date.now() - budget.startedAt > config.budgetDefaults.maxWallclockMs // wallclock
  );
}
```

`reportObjectWritten` is set by the loop controller after `generateObject` + `updateInvestigationSummary` succeed. Budget checks are evaluated after every step, not only at phase boundaries.

### 7.10 In-run tool result dedup

A plain in-memory `Map<argsHash, result>` is scoped to the current agent loop. Every reader tool call is hashed on `(toolName, normalizedArgs)` (sorted JSON of args). If the agent re-asks for the same window and filters, the cached result is returned without re-querying ClickHouse. The map is garbage-collected when the run ends. Pure closure, no infra.

### 7.7 Writer tools

- **`createSavedSearch`** — calls the existing saved-search service. Tags the record with `createdBy = systemUser._id` and stores a reference to the triggering investigation in a new `createdByInvestigationId` field. Returns the saved-search ID for the investigation artifacts list.
- **`createDashboard`** — calls the existing dashboard service. Builds tiles from the reader queries the agent already ran (the compaction wrapper tracks the last 5 executed queries per tool, keyed by `toolName`). Pinned to an "Investigations" folder — create the folder lazily if it doesn't exist.
- **`createDraftAlert`** — creates an Alert with `state = AlertState.DRAFT`, `createdBy = systemUser._id`, and standard fields. Draft alerts skip evaluation in the `check-alerts` task.
- **`updateInvestigationSummary`** — **not a model-facing tool.** Inlined into the loop controller as the final step after the report phase `generateObject` call succeeds. The loop controller calls it directly with the validated `generateObject` output; the model never invokes it. This avoids schema exposure, eliminates one tool-call slot, and ensures structured data is always written via `generateObject` validation rather than free-form model output.

## 8. Tool additions — new files

Most reader tools exist today in `packages/api/src/controllers/investigation-tools/tools.ts`. The new ones:

| Tool | Kind | Notes |
|---|---|---|
| `queryMetrics` | reader | Time-series over OTel metric names with filters, returns percentile stats |
| `searchPastInvestigations` | reader | Mongo lookup on `InvestigationMemory` by fingerprint, service, symptom |
| `getActiveAlerts` | reader | List currently firing alerts with state, threshold, last trigger |
| `findSimilarErrors` | reader | Longer-window variant of `searchLogs` tuned for recurrence detection |
| `createSavedSearch` | writer | Agent-tagged saved search creation |
| `createDashboard` | writer | Agent-tagged dashboard creation with pre-filled tiles (last 5 reader queries per tool) |
| `createDraftAlert` | writer | Alert creation in `DRAFT` state |
| `updateInvestigationSummary` | internal | **Not model-facing.** Loop controller calls this after `generateObject` succeeds; writes finding to Investigation doc and upserts InvestigationMemory. |

Each tool is declared through the AI SDK `tool()` helper with a Zod input schema kept deliberately flat (no nested discriminated unions) for Qwen tool-calling reliability.

## 9. Fingerprint algorithm

Deterministic, no LLM, per-source strategy with layered fallback.

```ts
function computeFingerprint(candidate: TriageCandidate, teamId: string): string {
  if (candidate.source === 'alert') {
    return sha1(`${teamId}|alert|${candidate.alertId}`);
  }

  // anomaly_sweep: pick the most specific signature available
  const normalize = (s: string) =>
    s
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\b\d+\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);

  const signature =
    candidate.exceptionType ??
    candidate.errorKind ??
    (candidate.topHttpStatusBucket && candidate.topOperationName
      ? `${candidate.topHttpStatusBucket}:${candidate.topOperationName}`
      : null) ??
    (candidate.topErrorMessage ? normalize(candidate.topErrorMessage) : null) ??
    'unknown';

  return sha1(`${teamId}|anomaly|${candidate.serviceName}|${signature}`);
}
```

Candidate field availability is driven by the triage ClickHouse query — fields that aren't present on the data return undefined and the fallback chain picks the next best option. A candidate with no extractable signature at all still gets a stable fingerprint via `'unknown'`, but those candidates are generally low quality and the sweep threshold tends to filter them out.

## 10. Lifecycle state machine

```
            triage inserts                   runner claims
pending  -------------------->  (pending)  -------------->  active
  ^                                                            |
  |         lease expired                                      |
  |         (attemptCount <= 3)                                |
  |<-------------------------------- active                    |
  |                                                            v
  |                                      +---- resolved (confidence >= medium, agent ok)
  |                                      |
  |                                      +---- needs_review (confidence low OR schema retries exhausted)
  |                                      |
  |                                      +---- failed (budget exhausted, provider error, attemptCount > 3)
  |
  +---- ignored (user action, v1.1)
  +---- exported (existing user flow, untouched)

Recurrence path:
resolved / needs_review  +  same fingerprint reappears after reopenAfterHours
  --> triage inserts new investigation with reopenedFrom = priorId
  --> InvestigationMemory.recurrenceCount increments on the memory record
```

Terminal states: `resolved`, `needs_review`, `failed`, `ignored`, `exported`. Only `resolved` and `needs_review` write `InvestigationMemory`.

## 11. Admin UI and user UI scope for v1

### 11.1 Platform admin surface

A new "Proactive Investigation" section in the existing platform admin page. Form bound to the Zod config schema. Fields:

- Enabled toggle
- Triage cron, runner cron
- Model name, base URL (API key label reads "stored in env")
- Max runs per team per hour
- Reopen after hours
- Memory TTL days
- Budget defaults (tool calls, tokens, wallclock)
- Anomaly sweep sub-form (enabled, error rate multiplier, min absolute count, top K)
- Qwen sub-form (thinking mode toggle, per-phase temperature grid)
- Circuit breaker (max failures per hour, cooldown)

Writes go through a new endpoint `PATCH /platform/settings/proactive-investigation` guarded by the platform-admin role.

### 11.2 User-facing UI (minimal)

- **Investigation list page** — existing list, add an "Auto investigations" filter backed by `entryPoint.type === 'proactive'`. Show status badge, trigger source label (`alert` vs `anomaly`), fingerprint preview (first 8 chars), recurrence count from the linked memory record.
- **Investigation detail** — existing messages view works for the agent conversation. Add a "Report" section above the messages rendering the `InvestigationMemory` record: summary, confidence, root cause, affected services, artifact links (saved search, dashboard, draft alert).
- **No lifecycle buttons in v1.** Users see `needs_review` as a status badge but cannot act on it from the UI. Promoting a draft alert is a single button on the draft alert itself, not on the investigation — that UI is adjacent to the alerts page.

### 11.3 Deferred to v1.1

- Investigation lifecycle toggles (`resolve`, `ignore`, `reopen`)
- Bulk triage panel ("show me all pending investigations")
- Per-team proactive-investigation settings (overrides of global defaults)
- Slack / webhook notification when an investigation completes

## 12. Configuration — Zod schema and defaults

```ts
// packages/common-utils/src/types/proactiveInvestigation.ts
import { z } from 'zod';

export const ProactiveInvestigationConfigSchema = z.object({
  enabled: z.boolean().default(false),

  triageCron: z.string().default('*/2 * * * *'),
  runnerCron: z.string().default('*/5 * * * *'),

  model: z.object({
    name: z.string().default('qwen3-32b-instruct'),
    baseUrl: z.string().url(),
  }),

  maxRunsPerTeamHour: z.number().int().positive().default(20),
  reopenAfterHours: z.number().positive().default(2),
  memoryTTLDays: z.number().int().positive().default(90),

  budgetDefaults: z.object({
    maxToolCalls: z.number().int().positive().default(12),
    maxTokens: z.number().int().positive().default(30_000),
    maxWallclockMs: z.number().int().positive().default(240_000),
    // Per-phase tool call soft caps (enforced by loop wrapper; breach flips to next phase)
    phaseToolCallCaps: z.object({
      hypothesize: z.number().int().positive().default(2),
      gather: z.number().int().positive().default(6),
      challenge: z.number().int().positive().default(3),
      report: z.number().int().positive().default(2),
    }),
  }),

  anomalySweep: z.object({
    enabled: z.boolean().default(true),
    errorRateMultiplier: z.number().positive().default(3),
    minAbsoluteCount: z.number().int().positive().default(10),
    topK: z.number().int().positive().default(5),
  }),

  qwen: z.object({
    enableThinking: z.boolean().default(true),
    temperaturePerPhase: z.object({
      plan: z.number().min(0).max(2).default(0.3),
      execute: z.number().min(0).max(2).default(0.1),
      verify: z.number().min(0).max(2).default(0.2),
      summarize: z.number().min(0).max(2).default(0.0),
    }),
    // thinking budget in tokens per phase (only applied when thinking is on)
    thinkingBudgetPerPhase: z.object({
      verify: z.number().int().positive().default(2048),
      summarize: z.number().int().positive().default(3072),
    }),
  }),

  circuitBreaker: z.object({
    maxFailuresPerHour: z.number().int().positive().default(5),
    cooldownMs: z.number().int().positive().default(3_600_000),
  }),
});

export type ProactiveInvestigationConfig = z.infer<
  typeof ProactiveInvestigationConfigSchema
>;
```

Defaults are applied in two places: the Zod schema (for fresh reads) and a one-time bootstrap writer that inserts a default `PlatformSetting` record on first deployment if one does not exist.

## 13. Guardrails summary

| Guard | Where enforced | Default |
|---|---|---|
| Per-investigation tool call cap | Agent loop wrapper | 12 total (2/6/3/2 per phase) |
| Per-investigation token cap | Agent loop wrapper | 30k total |
| Per-investigation wallclock cap | Agent loop wrapper | 240 seconds |
| Per-team runs per hour | Runner tick pre-claim | 20 |
| Per-team circuit breaker | Triage tick pre-enumeration | 5 failures in 1h = 1h cooldown |
| Global kill switch | Both tasks, tick entry | `enabled: false` |
| Attempt count cap | Lease reaper in triage | 3 |
| Provider retry | Agent loop wrapper | 3 attempts, exponential backoff |
| `generateObject` schema retry | Report phase | 3 attempts |

## 14. Testing strategy

### 14.1 Unit tests (`packages/api/src/.../__tests__`, Jest)

- Fingerprint hash stability and fallback order (all branches of Section 9).
- Dedup logic: same fingerprint input → skip; stale resolved + same fingerprint → reopen.
- Mongo claim race: concurrent `findOneAndUpdate` calls against an in-memory Mongo, assert exactly one succeeds.
- Tool compaction wrappers: known raw ClickHouse result shapes → expected compact shapes.
- Step-tag parser: malformed responses, missing tag, ambiguous tag.
- Tool-gate filter: each phase returns only the allowed subset.
- Config loader: Mongo miss returns defaults, Mongo hit overrides, cache TTL expires.
- Circuit breaker accounting: rolling window of failures.

### 14.2 Integration tests (`make dev-int`, real Mongo + ClickHouse, mocked LLM)

- **Triage end-to-end:** seed firing alerts and anomalous log patterns, run one triage tick, assert the expected investigations exist. Run a second tick, assert dedup. Mark one resolved with a past timestamp, run triage, assert reopen with `reopenedFrom`.
- **Runner end-to-end:** seed one `pending` investigation. Mock the AI SDK model to return a canned tool-calling sequence that exercises all four phases. Run one runner tick. Assert: claim succeeded, phases progressed in order, artifacts were created (real saved search + dashboard + draft alert rows in Mongo), memory was written, status flipped to `resolved`.
- **Lease expiry:** seed an `active` investigation with a past `leaseExpiresAt`. Run triage's lease reaper. Assert the investigation is back to `pending` with `attemptCount` incremented. Repeat until `attemptCount > 3` and assert transition to `failed`.
- **Budget exhaustion:** seed an investigation with `budget.maxToolCalls = 2`. Mock the LLM to call three tools. Assert the third call is rejected and the investigation ends in `failed`.
- **Circuit breaker:** seed 5 failed investigations for one team within the circuit breaker window. Run triage. Assert no new candidates are produced for that team until the cooldown expires.

### 14.3 Smoke test (manual, not CI)

A `dev:smoke` script in `packages/api/package.json` that runs one end-to-end investigation against a live Qwen deployment (gated behind `PROACTIVE_INVESTIGATION_SMOKE=true`). Useful for validating the Qwen prompt + tool-calling reliability after prompt changes.

## 15. Migration and backfill

- **`migrate-mongo`** migration adds the new fields to `Investigation` (all optional, no backfill needed for existing docs) and the new `fingerprint` field to `InvestigationMemory` (existing memories get no fingerprint; that is fine — they simply do not match future recurrences until they age out).
- **No ClickHouse migration** is required.
- **Index creation** is handled by Mongoose `createIndexes()` on boot, same as existing indexes.
- **Platform setting bootstrap:** on boot, if no `PlatformSetting` with `key: 'proactiveInvestigation'` exists, insert one with `enabled: false` and all other defaults. Operators explicitly flip enabled to true via the admin UI when ready.
- **System user bootstrap:** extend the existing setup-defaults reconciliation path to create the `proactive-agent@system` user if it does not exist.
- **`check-alerts` task update:** add one skip condition `state !== AlertState.DRAFT` to the alert-evaluation loop.
- **`data-retention` task update:** add a prune step for `InvestigationMemory` older than the configured TTL.

## 16. Open items and future work

1. **Embedding-based memory retrieval.** v1 uses structured facet filtering (fingerprint, affected services, symptom category). If recurrence recall precision turns out to be the bottleneck, adding embeddings via a vector index is an isolated v2 improvement — memory retrieval is already behind a tool interface.
2. **Per-team config overrides.** v1 uses a single global PlatformSetting. v1.1 can add per-team overrides stored on the `Team` document that merge on top of global defaults.
3. **Slack / webhook notifications.** v1 produces artifacts but does not push them anywhere. A simple notification channel reusing the existing webhook plumbing is a natural v1.1 addition.
4. **Anomaly sweep signal sources.** v1 only looks at error-count deltas. Latency deltas, saturation signals, and throughput cliffs are all candidates for v2.
5. **Remediation suggestions.** Explicitly out of scope for v1 (requires deploy-tracking and runbook integrations that don't exist). Potential v2.
6. **Investigation lifecycle UI.** Resolve / ignore / reopen buttons on the investigation detail page are deferred to v1.1.
7. **Multi-replica task runner.** Not needed for v1 given current deployment shape. If HyperDX grows into sharded task runners, the Mongo atomic claim (already implemented) handles coordination without code changes — the only additional work is electing which replica owns which shard of teams.

## 17. Files to create or modify

| File | Action |
|---|---|
| `packages/api/src/models/investigation.ts` | Extend schema with new fields (Section 4.1) |
| `packages/api/src/models/investigationMemory.ts` | Add `fingerprint` field and index (Section 4.2) |
| `packages/api/src/models/alert.ts` | Add `DRAFT` to `AlertState` enum (Section 4.3) |
| `packages/api/src/tasks/types.ts` | Already adds `PROACTIVE_INVESTIGATION` (uncommitted diff); split into `PROACTIVE_INVESTIGATION_TRIAGE` and `PROACTIVE_INVESTIGATION_RUN` |
| `packages/api/src/tasks/proactiveInvestigationTriage.ts` | New — triage task body |
| `packages/api/src/tasks/proactiveInvestigationRun.ts` | New — runner task body |
| `packages/api/src/tasks/checkAlerts.ts` | One-line update to skip `state === AlertState.DRAFT` |
| `packages/api/src/tasks/dataRetention.ts` | Add InvestigationMemory pruning step |
| `packages/api/src/controllers/investigation-agent.ts` | Refactor to support phase-directive prompt + step-tag parser + tool gating + compaction + in-run dedup map |
| `packages/api/src/controllers/investigation-tools/tools.ts` | Add new reader and writer tools with compaction wrappers |
| `packages/api/src/controllers/investigation-tools/schema.ts` | Add Zod schemas for new tool inputs |
| `packages/api/src/controllers/proactiveInvestigationConfig.ts` | New — cached PlatformSetting loader |
| `packages/api/src/controllers/fingerprint.ts` | New — pure fingerprint function |
| `packages/api/src/controllers/systemUser.ts` | New — system user bootstrap and lookup |
| `packages/api/src/routers/api/platform.ts` (or equivalent) | Add `PATCH /platform/settings/proactive-investigation` endpoint |
| `packages/api/src/routers/api/investigations.ts` | Extend to expose new fields on the list and detail endpoints |
| `packages/api/migrations/...` | New migrate-mongo migration for index creation and default PlatformSetting insert |
| `packages/common-utils/src/types/proactiveInvestigation.ts` | New — Zod config schema |
| `packages/app/src/components/PlatformAdmin/ProactiveInvestigationSection.tsx` | New — admin form bound to the Zod schema |
| `packages/app/src/components/Investigation/InvestigationList.tsx` | Add "Auto investigations" filter and proactive badges |
| `packages/app/src/components/Investigation/InvestigationReport.tsx` | New — render `InvestigationMemory` findings |
| `packages/app/src/components/Alert/AlertList.tsx` | Show `DRAFT` state and add "Promote" button |

## 18. Rollout plan

1. **Phase 1 — schema + config scaffolding:** schema migrations, system user bootstrap, PlatformSetting bootstrap, Zod config, cached loader. No behavior change.
2. **Phase 2 — triage task:** enumerate, dedup, fingerprint, insert pending. Still no LLM. Can be shipped and observed in production with `enabled: false` to validate candidate volume and dedup behavior.
3. **Phase 3 — agent loop refactor:** phase-directive prompt, step-tag parser, tool gating, compaction, in-run dedup, budget enforcement. Tested with mocked LLM and one real Qwen smoke test.
4. **Phase 4 — runner task:** claim, execute agent loop, write artifacts and memory.
5. **Phase 5 — writer tools and draft alerts:** `createSavedSearch`, `createDashboard`, `createDraftAlert`, `check-alerts` skip condition, promote button.
6. **Phase 6 — admin UI and user UI:** platform admin form, investigation list filter, report view.
7. **Phase 7 — enable in staging:** flip `enabled: true` on a dev or SIT team, observe for a week.
8. **Phase 8 — enable in production:** opt-in per team via initial deployment defaults.

Each phase is independently revertable.
