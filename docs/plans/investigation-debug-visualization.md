# Plan: Investigation Debug Visualization

> Source PRD: `prds/investigation-debug-visualization.md`

## Architectural decisions

- **New route**: `GET /api/investigations/:id/stream` — added to existing `investigations.ts` router alongside `GET /:id/loop-state`
- **Auth**: `getNonNullUserWithTeam` middleware (same as all investigation routes)
- **Operator gate**: `teamRole === 'owner'` server-side; `thinking` events stripped before write — never client-filtered
- **Transport**: SSE (`text/event-stream`) via `fetch` + `ReadableStream` + `TextDecoder` — matches `useInvestigationChat` pattern; no `EventSource`
- **EventBus**: in-process `EventEmitter` singleton at `packages/api/src/utils/investigationEventBus.ts`; single-replica assumption documented in file (Redis pub/sub deferred)
- **Schema additions to `ILoopState`**: `toolCallLog: IToolCallEntry[]`, `thinkingLog: IThinkingEntry[]`; `ILoopPhaseHistory` extended with `summaryText: string`
- **Event ID**: `callIndex` for tool events; monotonic counter for phase/meta events; used for `Last-Event-ID` reconnection
- **Replay source of truth**: DB fields (`toolCallLog`, `thinkingLog`, `phaseHistory`) — runner MUST write to Mongo before emitting to EventBus
- **UI**: Mantine components; `DebugDrawer` opens from investigation detail page header; all authenticated team members can open it

---

## Phase 1: Scaffold — EventBus, Phase Stream, Skeleton Drawer

**User stories**: 1, 9, 13

### What to build

End-to-end pipeline for phase-level visibility. The runner emits `phase_start` and `phase_end` events to a new `InvestigationEventBus` singleton and persists `summaryText` to `ILoopPhaseHistory`. A new `GET /:id/stream` SSE endpoint subscribes to the EventBus and streams events to authenticated clients. The frontend `useInvestigationStream` hook connects to the endpoint and drives a minimal `DebugDrawer` containing a `PhaseTimeline` (Mantine `Stepper`). The drawer opens via a "Debug" button added to the investigation detail page header. The active phase auto-expands; completed phases collapse.

No tool call detail, budget, or replay in this phase — just the skeleton that proves every layer connects.

### Acceptance criteria

- [ ] `ILoopPhaseHistory` has `summaryText: string`; `ILoopState` schema updated in Mongoose model
- [ ] `InvestigationEventBus` singleton exists; emits/receives `phase_start` and `phase_end` events keyed by `investigationId`
- [ ] `GET /api/investigations/:id/stream` returns `text/event-stream`; requires auth; emits `phase_start` and `phase_end` SSE frames
- [ ] Runner emits `phase_start`/`phase_end` to EventBus (and persists `summaryText`) at each phase transition
- [ ] `useInvestigationStream` hook connects, parses SSE frames, exposes `{ currentPhase, phaseGroups, isComplete, error }`
- [ ] "Debug" button in investigation detail header opens `DebugDrawer` (Mantine `Drawer`, right, 480px)
- [ ] `PhaseTimeline` shows four phases; active phase auto-expands; completed phases show checkmark
- [ ] Drawer is visible to all authenticated team members
- [ ] Hook closes the fetch stream on `investigation_complete`, `investigation_failed`, or unmount
- [ ] **Tests**: unit — EventBus emit/subscribe/cleanup; integration — `GET /:id/stream` phase events for live investigation; hook — state transitions from `phase_start` → `phase_end` → `investigation_complete` with mocked ReadableStream

---

## Phase 2: Tool Call Cards

**User stories**: 3, 12

### What to build

Full tool call visibility. The runner appends each tool invocation to `toolCallLog` in Mongo and emits `tool_call`, `tool_result`, and `tool_error` events to the EventBus before/after each tool execution. The SSE endpoint passes these events downstream. The hook adds tool events to `phaseGroups`. The drawer renders a `PhaseSection` (Mantine `Accordion.Item`) per phase containing ordered `ToolCallCard` components — each showing tool name, duration badge, token badge, args, and result/error. The active tool call's result is expanded; completed calls are collapsed. Error calls show a red left border. Phases auto-expand when active and collapse when complete.

### Acceptance criteria

- [ ] `toolCallLog` schema field exists on `ILoopState` with shape `{ callIndex, phase, tool, args, result?, error?, durationMs, tokensUsed }`
- [ ] Runner appends to `toolCallLog` and emits `tool_call` before execution, `tool_result`/`tool_error` after
- [ ] SSE endpoint streams `tool_call`, `tool_result`, `tool_error` events with correct `id:` (callIndex)
- [ ] `PhaseSection` renders inside `PhaseTimeline`; contains `ToolCallCard` list ordered by `callIndex`
- [ ] `ToolCallCard`: tool name, duration, tokens, args (flat key=value), result (`Code` block), error (red border)
- [ ] Active call's result row is expanded; completed calls collapsed
- [ ] Phase auto-expands when it receives its first `tool_call`; collapses on `phase_end`
- [ ] **Tests**: unit — `toolCallLog` append ordering; integration — SSE tool events for live investigation; component — `ToolCallCard` renders error state with red border, result collapsed for completed calls

---

## Phase 3: Budget Bar

**User stories**: 4

### What to build

Budget consumption visibility. The runner includes a `budgetSnapshot: { toolCallsUsed, toolCallsTotal, tokensUsed, tokensTotal }` in every `phase_start` and `phase_end` event. The hook tracks the latest `budgetSnapshot`. The drawer renders a `BudgetBar` at the top: two Mantine `Progress` bars (tools used, tokens used) with color thresholds (orange ≥ 75%, red ≥ 90%) plus a wallclock ticker (`useInterval`, 1 s) showing elapsed time since investigation start.

### Acceptance criteria

- [ ] `budgetSnapshot` shape defined and included in `phase_start`/`phase_end` event payloads
- [ ] Runner populates `budgetSnapshot` from actual loop state counters at each phase boundary
- [ ] Hook exposes `budgetSnapshot` (latest value); updates on every `phase_start`/`phase_end`
- [ ] `BudgetBar` renders two `Progress` bars with correct percentages and color thresholds
- [ ] Color is orange when ≥ 75% and red when ≥ 90% for both bars
- [ ] Wallclock ticker increments every 1 s while investigation is active; stops on completion
- [ ] **Tests**: component — `BudgetBar` renders orange at 75%, red at 90%, neutral below 75%; hook — `budgetSnapshot` updates on phase events

---

## Phase 4: Replay Mode

**User stories**: 2, 5, 6, 7

### What to build

Full replay for finished investigations. A `buildReplayEventSequence` utility merges `phaseHistory`, `toolCallLog`, and `thinkingLog` from the DB into canonical per-phase order: `phase_start` → `tool_call`/`tool_result` pairs → `thinking` → `phase_end`, ending with `investigation_complete`/`investigation_failed`. The SSE endpoint detects a terminal investigation status and enters replay mode: it calls `buildReplayEventSequence` and streams events with configurable inter-event delays (`?speed=1|5|10` → 80/16/8 ms). `?startPhase=<phase>` skips earlier events and injects the last known `budgetSnapshot` into the first emitted event. Ends with `replay_complete`.

The hook exposes `isReplay` and `isComplete`. The drawer shows `ReplayControls` (play/pause, speed selector, phase jump) only when `isReplay === true`. Play/pause buffers events client-side without re-requesting. Speed changes and phase jumps close and reopen the fetch stream with updated query params.

### Acceptance criteria

- [ ] `buildReplayEventSequence(investigation, { isOwner, startPhase })` returns events in canonical phase order
- [ ] Function correctly interleaves `tool_call`/`tool_result` pairs by `callIndex` within each phase
- [ ] `?startPhase` slices earlier events; injects last `budgetSnapshot` into first emitted event
- [ ] SSE replay mode streams at correct interval for `?speed=1` (80 ms), `?speed=5` (16 ms), `?speed=10` (8 ms)
- [ ] Replay ends with `{ type: 'replay_complete' }` SSE event
- [ ] Hook sets `isReplay: true` for terminal investigations; exposes `isComplete`
- [ ] `ReplayControls` renders only when `isReplay === true`
- [ ] Play/pause buffers events without closing the stream; speed/phase-jump closes and reopens fetch
- [ ] Phase jump buttons skip to the selected phase (closes + reopens with `?startPhase=`)
- [ ] **Tests**: unit — `buildReplayEventSequence` full ordering, `startPhase` slicing, `budgetSnapshot` injection; integration — replay SSE for resolved investigation at each speed; hook — play/pause buffering, speed change closes+reopens stream

---

## Phase 5: Owner Thinking Blocks

**User stories**: 8

### What to build

Operator-only visibility into AI reasoning. The runner appends per-phase thinking content to `thinkingLog` (`{ phase, tokenCount, content }`) and emits `thinking` events to the EventBus. The SSE endpoint strips `thinking` events when `req.user.teamRole !== 'owner'` — server-side, before writing to the response. `buildReplayEventSequence` also filters thinking when `!isOwner`. The hook passes `isOwner` (derived from session data, never inferred client-side) to the drawer. The drawer renders a `ThinkingBlock` (Mantine `Accordion`, one item per phase, `ScrollArea` capped at 300 px) below a divider inside each `PhaseSection` — only when `isOwner` is true.

### Acceptance criteria

- [ ] `thinkingLog` schema field exists with shape `{ phase, tokenCount, content }`
- [ ] Runner appends thinking content and emits `thinking` events after each phase
- [ ] SSE endpoint strips `thinking` events for `teamRole !== 'owner'` before writing to response
- [ ] `buildReplayEventSequence` filters `thinking` events when `!isOwner`
- [ ] `ThinkingBlock` renders only when `isOwner` prop is `true`; not rendered for non-owners
- [ ] `ThinkingBlock`: one `Accordion` item per phase that has thinking data; `ScrollArea` max 300 px
- [ ] `isOwner` is derived from session in the page component and passed as prop — no client-side filtering of events
- [ ] **Tests**: integration — `GET /:id/stream` returns `thinking` events for owner, omits them for non-owner (same fixture); unit — `buildReplayEventSequence` omits thinking when `isOwner=false`; component — `ThinkingBlock` not rendered when `isOwner=false`

---

## Phase 6: Resilience — Reconnection, Waiting State, Error State

**User stories**: 9, 10, 11

### What to build

Production-grade reliability. Three behaviors:

**Waiting state**: when the investigation is `pending`, the SSE endpoint polls Mongo every 2 s (max 10 polls, 20 s total) emitting `{ type: 'waiting' }` synthetic events. If the investigation transitions to `active` within the window, the endpoint switches to EventBus subscription. If it does not start in time, emit `investigation_failed` and close. The drawer shows a spinner on `waiting` events.

**Reconnection**: the SSE endpoint reads the `Last-Event-ID` request header. For live mode, it replays `toolCallLog` entries with `callIndex > lastEventId` before subscribing to the EventBus. For replay mode, it restarts `buildReplayEventSequence` from `callIndex > lastEventId`. The hook sets `Last-Event-ID` on reconnect fetch.

**Timeout guard**: if the SSE endpoint receives no EventBus event for 30 s during live mode, it emits a synthetic `{ type: 'investigation_failed', error: 'runner_timeout' }` and ends the response. The drawer shows a red error state with the error message.

### Acceptance criteria

- [ ] SSE endpoint emits `waiting` events at 2 s intervals when investigation is `pending`; transitions to EventBus on `active`
- [ ] Polling stops after 10 polls and emits `investigation_failed` if investigation never activates
- [ ] Drawer renders spinner on `waiting` events
- [ ] `Last-Event-ID` header processed in live mode: tool events with `callIndex ≤ lastEventId` skipped before EventBus subscription
- [ ] `Last-Event-ID` header processed in replay mode: `buildReplayEventSequence` skips events with `callIndex ≤ lastEventId`
- [ ] Hook sends `Last-Event-ID` header on reconnect (after network drop)
- [ ] 30 s no-event timeout emits `investigation_failed` with `error: 'runner_timeout'`
- [ ] Drawer shows red error state with message on `investigation_failed`
- [ ] Stream connection open/close logged with `investigationId` (using existing logger)
- [ ] **Tests**: integration — waiting poll transitions to active; timeout guard fires after 30 s of silence; `Last-Event-ID` skips already-seen events in both live and replay mode; non-owner cannot see thinking events after reconnect
