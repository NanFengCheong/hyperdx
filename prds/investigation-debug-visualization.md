# PRD: Investigation Debug Visualization

## Problem Statement

The proactive investigation runner executes a multi-phase AI agent loop invisibly. Users receive a finished report but have no insight into how the agent reasoned, which tools it called, what evidence it gathered, or why it reached a given confidence level. This creates a trust gap — especially for `needs_review` outcomes where users must decide whether to act. Engineers cannot debug misbehaving investigations without access to the raw tool call log.

## Solution

Add a real-time debug drawer to the investigation detail page that streams agent activity as the investigation runs and replays it for finished investigations. The same SSE endpoint serves both modes. End users see phase progress, tool calls, and results. Team owners (operators) additionally see the AI's raw thinking blocks. Finished investigations can be replayed at configurable speeds.

## User Stories

1. As an engineer watching a live investigation, I want to see which phase the agent is in and which tools it is calling, so I can understand whether it is making progress.
2. As an engineer reviewing a `needs_review` outcome, I want to replay the full investigation step by step, so I can understand the reasoning that led to that result and decide whether to act.
3. As an engineer, I want to see each tool call's arguments and the result it returned, so I can verify the agent queried the right data.
4. As an engineer, I want to see how much of the token and tool-call budget has been consumed, so I understand whether the investigation was budget-constrained.
5. As an engineer, I want to pause and resume a replay, so I can inspect a particular tool call in detail.
6. As an engineer, I want to jump directly to a specific phase in a replay, so I don't have to watch phases I have already reviewed.
7. As an engineer, I want to replay an investigation at 5× or 10× speed, so I can scan completed investigations quickly.
8. As a team owner, I want to see the AI's raw thinking blocks for each phase, so I can debug prompt quality and reasoning errors.
9. As an engineer, I want the drawer to show a waiting spinner when an investigation is queued but not yet running, so I know it has not been dropped.
10. As an engineer, I want the drawer to reconnect automatically if my network drops, resuming from where it left off, so I don't lose context.
11. As an engineer watching a live investigation, I want to see a red error state if the runner crashes, so I know the investigation has failed and why.
12. As an engineer, I want each phase to auto-expand in the drawer as it becomes active and collapse when complete, so my focus follows the agent.
13. As an engineer, I want to open the debug drawer without leaving the investigation chat, so I can correlate agent activity with the final summary.

## Implementation Decisions

### Schema additions to Investigation model

Add to `ILoopState` in `packages/api/src/models/investigation.ts`:

- `toolCallLog`: array of `{ callIndex, phase, tool, args, result?, error?, durationMs, tokensUsed }` — appended on every tool_call + tool_result/tool_error pair
- `thinkingLog`: array of `{ phase, tokenCount, content }` — appended per phase for thinking blocks
- Extend each `ILoopPhaseHistory` entry with `summaryText: string` — the phase-end compaction summary

These three fields are the authoritative source for replay. The runner must append to them on every relevant event before emitting to the EventBus.

### `InvestigationEventBus`

New singleton: `packages/api/src/utils/investigationEventBus.ts`

- Extends Node.js `EventEmitter`
- `setMaxListeners(100)` to support N concurrent SSE connections
- Runner emits: `investigationEventBus.emit(investigationId, event)`
- SSE handler subscribes per connection and removes listener on response close

### SSE endpoint

New route: `GET /api/investigations/:id/stream` in `packages/api/src/routers/api/investigations.ts`

Auth: same `getNonNullUserWithTeam` middleware as all other investigation routes.

Operator gate: `thinking` events are stripped server-side when `req.user.teamRole !== 'owner'`. Never rely on client-side filtering.

**Live mode** (`status` is `pending` or `active`):
1. If `pending`: poll Mongo every 2s (max 10 polls), emit `{ type: 'waiting' }` each poll
2. Subscribe to EventBus channel `investigationId`
3. Strip `thinking` events for non-owners
4. Write `id: <eventIndex>\ndata: <json>\n\n` per event
5. On `investigation_complete` or `investigation_failed`: flush, end response
6. Timeout guard: if no event in 30s, emit synthetic `{ type: 'investigation_failed', error: 'runner_timeout' }` and end

**Replay mode** (`status` is `resolved`, `needs_review`, `failed`, `exported`, or `ignored`):
1. Call `buildReplayEventSequence(investigation, { isOwner, startPhase })`
2. Stream events with `await sleep(intervalMs)` between each
3. `intervalMs` from `?speed=` query param: `1`→80ms, `5`→16ms, `10`→8ms
4. `?startPhase=<phase>` skips earlier events; inject the last known `budgetSnapshot` into the first emitted event
5. End with `{ type: 'replay_complete' }`

**Reconnection** via `Last-Event-ID` header:
- Live: replay `toolCallLog` entries with `callIndex > lastEventId` before re-subscribing
- Replay: restart from `callIndex > lastEventId`

### `buildReplayEventSequence`

New function in the investigations router or a shared util. Merges `phaseHistory`, `toolCallLog`, and `thinkingLog` into canonical per-phase order: `phase_start` → `tool_call`/`tool_result` pairs → `thinking` → `phase_end`. Filters `thinking` when `!isOwner`. Slices from `startPhase` when provided.

### Event schema

All events carry `investigationId`. Types:

- `waiting` — spinner while pending
- `phase_start` — `{ phase, budgetSnapshot }`
- `tool_call` — `{ phase, tool, args, callIndex }`
- `tool_result` — `{ callIndex, result, durationMs, tokensUsed }`
- `tool_error` — `{ callIndex, error, durationMs }`
- `thinking` — `{ phase, tokenCount, content }` (owner-only)
- `phase_end` — `{ phase, summaryText, budgetSnapshot }`
- `investigation_complete` — `{ status, artifactIds }`
- `investigation_failed` — `{ error }`
- `replay_complete` — replay mode only

SSE frame `id` = `callIndex` for tool events, monotonic counter for others.

### Frontend hook: `useInvestigationStream`

New hook: `packages/app/src/hooks/useInvestigationStream.ts`

Uses `fetch` + `ReadableStream` + `TextDecoder` to match the existing `useInvestigationChat` pattern. Does NOT use the browser `EventSource` API (inconsistent with codebase convention).

Accepts: `investigationId`, `opts: { speed?, startPhase? }`

Returns: `{ events, currentPhase, budgetSnapshot, phaseGroups, isReplay, isComplete, error }`

Closes the fetch stream on `investigation_complete`, `investigation_failed`, `replay_complete`, or component unmount.

### Frontend components

All components use Mantine. Follow patterns from `InvestigationChat.tsx` and `InvestigationSidePanel.tsx`.

**`DebugDrawer`** — Mantine `Drawer` (position=right, size=480). Opened by a "Debug" button added to the investigation detail page header. Visible to all authenticated team members. Composes: `BudgetBar`, `PhaseTimeline`, `PhaseSection[]`, `ThinkingBlock` (owners only), `ReplayControls` (terminal investigations only).

**`BudgetBar`** — Two Mantine `Progress` bars (tools, tokens) + wallclock ticker (`useInterval`, 1s). Color thresholds: orange at 75%, red at 90%.

**`PhaseTimeline`** — Mantine `Stepper` with four items. Clicking a completed phase expands that `PhaseSection` and collapses others.

**`PhaseSection`** — Mantine `Accordion.Item` per phase. Auto-expands the active phase. Contains ordered `ToolCallCard` list.

**`ToolCallCard`** — Mantine `Card`. Header: tool name, duration badge, token badge, status icon. Args row: flat key=value. Result row: `Code` block, collapsed for completed calls, expanded for active call. Error state: red left border.

**`ThinkingBlock`** — Rendered only when `isOwner` prop is `true` (derived from session, passed from parent — never filtered client-side). Mantine `Accordion` below a divider. One item per phase with thinking data. `ScrollArea` capped at 300px.

**`ReplayControls`** — Rendered only when `isReplay === true`. Play/pause buffers incoming events client-side without re-requesting. Speed changes (1×/5×/10×) and phase jumps close and reopen the fetch stream with updated query params.

### Runner integration

The proactive investigation runner (`packages/api/src/tasks/proactiveInvestigation.ts` and `packages/api/src/controllers/investigation-agent.ts`) must:
1. Import `investigationEventBus` from utils
2. Emit events at every phase start, tool call, tool result, tool error, thinking block, phase end, and investigation terminal state
3. Append to `toolCallLog`, `thinkingLog`, `phaseHistory.summaryText` in Mongo before emitting (so a subscriber joining mid-stream can always replay from DB)

## Testing Decisions

Good tests for this feature verify observable behavior through public interfaces, not internal state:

- **`buildReplayEventSequence`**: unit tests covering full event sequence ordering, `startPhase` slicing, thinking event filtering for non-owners, and `budgetSnapshot` injection. Use `__tests__/investigation.test.ts` as the pattern (Jest + Mongoose fixtures).
- **`GET /:id/stream`**: integration tests for live mode (mock EventBus emitting events), replay mode (fixture investigation with populated logs), `Last-Event-ID` reconnection, `thinking` event stripping for non-owners, and 30s timeout guard.
- **`useInvestigationStream`**: React hook tests with mocked `fetch` returning a ReadableStream of SSE chunks. Verify state transitions (waiting → active → complete), error handling, and cleanup on unmount.
- **`BudgetBar`/`PhaseTimeline`/`ToolCallCard`**: shallow render tests verifying color thresholds and correct badge values for representative budget snapshots.

Prior art: `packages/api/src/controllers/__tests__/investigation.test.ts` for controller test structure; `packages/app/src/hooks/useInvestigations.ts` for hook test patterns.

## Out of Scope

- Download investigation trace as JSON
- Shareable replay links with encoded URL params
- Inline annotation on tool call results
- Mobile-responsive drawer layout
- WebSocket transport (SSE is sufficient for unidirectional streaming)
- New RBAC roles or `isOperator` user flags — operator gate uses existing `teamRole === 'owner'`
- Multi-replica EventBus fanout (Redis pub/sub deferred; single-replica assumption documented)

## Further Notes

- The runner is assumed to run on a single replica. If horizontal scaling is added later, the in-process `EventEmitter` EventBus must be replaced with Redis pub/sub. This constraint should be documented in the EventBus file.
- The `pending`-state poll loop (max 20s) assumes investigations are queued and started within that window. If queue latency grows, increase `maxPolls` or move to a longer-polling strategy.
- `Last-Event-ID` reconnection for live mode replays from `toolCallLog` which is persisted per-event. This means the runner MUST write to Mongo before emitting to the EventBus — if the process crashes between DB write and emit, the event is silently lost. This is acceptable for v1.
- No new Mongoose indexes are required for `toolCallLog` or `thinkingLog` — they are always accessed by `_id` (investigation lookup) and traversed in full for replay.

## Decisions Log

Q: Who is the "operator" audience — is there an existing role concept?
A: Team `owner` role = operator. Use `req.user.teamRole === 'owner'` server-side.
Why: No existing `isOperator` flag in the codebase. `teamRole` is already populated by `getNonNullUserWithTeam` middleware.

Q: Where should `InvestigationEventBus` live?
A: `packages/api/src/utils/investigationEventBus.ts`
Why: `/packages/api/src/lib/` does not exist; all shared API utilities live in `/utils/`.

Q: Use EventSource or fetch+ReadableStream for the client hook?
A: `fetch` + ReadableStream (matching `useInvestigationChat` pattern).
Why: The entire codebase uses manual SSE parsing via `fetch`; EventSource would be inconsistent and adds no benefit for this unidirectional use case.

Q: Do `toolCallLog` and `thinkingLog` need to be added to the Investigation Mongoose schema?
A: Yes — both fields must be added as schema arrays alongside `phaseHistory`.
Why: They don't exist today; replay requires them to be persisted per-investigation in Mongo.

Q: Does `phaseHistory` need extending with `summaryText`?
A: Yes — add `summaryText: string` to each `ILoopPhaseHistory` entry.
Why: Phase-end compaction summary must appear in `PhaseSection` headers and be available for replay event reconstruction.

Q: Should the SSE endpoint be a new route or extend an existing one?
A: New route `GET /:id/stream` added to the existing `investigations.ts` router.
Why: Matches the pattern of `GET /:id/loop-state` alongside other investigation sub-resource routes.

Q: How is the "pending" poll handled — server or client?
A: Server-side poll loop (max 10 × 2s = 20s), emitting synthetic `waiting` events.
Why: Keeps reconnection logic on the server; client handles the event stream uniformly regardless of investigation state.

Q: What is the replay interval control model?
A: Default 80ms, `?speed=1|5|10` → 80/16/8ms. Changing speed closes and reopens the fetch stream with the new param.
Why: Client-side speed control via reconnection is simpler than server-side buffering or rate-change signalling.

Q: Where does the "Debug" button that opens the drawer live?
A: Investigation detail page header, alongside existing title/export controls.
Why: Matches `InvestigationSidePanel` placement pattern; doesn't obscure the main chat area.

Q: What tests are needed?
A: Unit tests for `buildReplayEventSequence` and EventBus; integration tests for `GET /:id/stream`; hook tests with mocked fetch; component render tests for threshold-dependent UI.
Why: Follows existing `__tests__/investigation.test.ts` controller test structure.

Q: What is explicitly out of scope?
A: JSON trace download, shareable replay links, inline annotations, mobile layout, WebSocket, new RBAC roles.
Why: Design doc section 10 defers these to v1.1.

Q: Security — who can access the stream endpoint?
A: All authenticated team members (`getNonNullUserWithTeam`); `thinking` events stripped server-side for non-owners.
Why: Operator gate must be server-enforced; client-side filtering alone is insufficient.

Q: Observability — what to instrument?
A: Log stream connection open/close with `investigationId`; reuse existing OTel tool-call counters in the runner.
Why: Investigation agent already has OTel instrumentation; no new metrics warranted for v1.
