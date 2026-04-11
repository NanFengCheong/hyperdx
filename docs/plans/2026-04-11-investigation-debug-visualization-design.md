# Investigation Debug Visualization — Design

- **Date:** 2026-04-11
- **Status:** Approved for implementation planning
- **Scope:** `packages/api` (SSE endpoint, EventBus, replay), `packages/app` (DebugDrawer + components)
- **Depends on:** `2026-04-11-proactive-investigation-design.md` (Investigation, loopState, phaseHistory data model)

## 1. Problem and motivation

The proactive investigation runner executes a multi-phase agent loop invisibly. Users receive a finished report but have no insight into how the agent reasoned, which tools it called, what evidence it gathered, or why it reached a given confidence level. This creates a trust gap — especially for `needs_review` outcomes where users must decide whether to act.

This feature adds a real-time debug panel that streams the investigation as it runs and replays it for finished investigations. Two audiences: end users (progress + findings), platform operators (full tool args, results, thinking blocks, budget burn).

## 2. Decision summary

| Decision | Choice |
|---|---|
| Streaming mechanism | SSE + in-process `EventEmitter` singleton |
| Live vs replay | Same SSE endpoint, same event schema; endpoint auto-detects terminal status and replays |
| UI placement | Side drawer on existing investigation detail page |
| Thinking block visibility | Operator-only, collapsed by default, server-gated |
| Replay controls | Play/pause, speed (1×/5×/10×), jump-to-phase via `?startPhase=` |

## 3. Architecture overview

```
Runner (single replica)
  └─ emits InvestigationEvent → InvestigationEventBus (EventEmitter singleton)

GET /api/investigations/:id/stream  (SSE)
  ├─ LIVE: subscribe to EventBus → flush events as SSE frames
  └─ REPLAY: read toolCallLog + thinkingLog + phaseHistory from Mongo
              → reconstruct event sequence → stream with configurable interval

packages/app
  └─ useInvestigationStream() (EventSource)
       └─ DebugDrawer
            ├─ BudgetBar
            ├─ PhaseTimeline
            ├─ PhaseSection[] (Accordion)
            │    └─ ToolCallCard[]
            ├─ ThinkingBlock (operator-only)
            └─ ReplayControls (terminal investigations only)
```

## 4. Event schema

All events carry `investigationId` and are emitted by the runner via `InvestigationEventBus.emit(investigationId, event)`.

```ts
// packages/api/src/lib/investigationEventBus.ts

type Phase = 'hypothesize' | 'gather' | 'challenge' | 'report';

interface BudgetSnapshot {
  consumedToolCalls: number;
  maxToolCalls: number;
  consumedTokens: number;
  maxTokens: number;
  elapsedMs: number;
  maxWallclockMs: number;
}

interface ArtifactIds {
  savedSearchIds: string[];
  dashboardIds: string[];
  draftAlertIds: string[];
}

type InvestigationEvent =
  | { type: 'phase_start';            phase: Phase; budgetSnapshot: BudgetSnapshot }
  | { type: 'tool_call';              phase: Phase; tool: string; args: Record<string, unknown>; callIndex: number }
  | { type: 'tool_result';            callIndex: number; result: unknown; durationMs: number; tokensUsed: number }
  | { type: 'tool_error';             callIndex: number; error: string; durationMs: number }
  | { type: 'thinking';               phase: Phase; tokenCount: number; content: string }  // operator-only
  | { type: 'phase_end';              phase: Phase; summaryText: string; budgetSnapshot: BudgetSnapshot }
  | { type: 'investigation_complete'; status: 'resolved' | 'needs_review'; artifactIds: ArtifactIds }
  | { type: 'investigation_failed';   error: string }
  | { type: 'replay_complete' }       // replay mode only
```

Each SSE frame carries an `id` equal to `callIndex` (or a monotonic counter for non-tool events) to support `Last-Event-ID` reconnection.

## 5. Backend — `InvestigationEventBus`

File: `packages/api/src/lib/investigationEventBus.ts`

```ts
import { EventEmitter } from 'node:events';

class InvestigationEventBus extends EventEmitter {}
export const investigationEventBus = new InvestigationEventBus();
investigationEventBus.setMaxListeners(100); // N concurrent SSE connections
```

Runner usage (in `packages/api/src/controllers/proactiveInvestigationRunner.ts`):

```ts
import { investigationEventBus } from '../lib/investigationEventBus';

// emit after each agent step
investigationEventBus.emit(investigationId, { type: 'tool_call', phase, tool, args, callIndex });
```

## 6. Backend — SSE endpoint

Route: `GET /api/investigations/:id/stream`

Added to `packages/api/src/routers/api/investigations.ts` alongside existing investigation routes.

### 6.1 Live mode

```
investigation.status ∈ { pending, active }
```

1. If `status === 'pending'`: poll Mongo every 2s (max 10 polls = 20s) until status flips to `active`. Flush a synthetic `{ type: 'waiting' }` event each poll so the client shows a spinner.
2. Subscribe to `investigationEventBus` on channel `investigationId`.
3. For each event received:
   - Strip `thinking` events if `!req.user.isOperator`.
   - Write `id: <eventIndex>\ndata: <json>\n\n`.
4. On `investigation_complete` or `investigation_failed`: flush the event, end the response.
5. **Timeout guard:** if no event arrives within 30s, emit synthetic `{ type: 'investigation_failed', error: 'runner_timeout' }` and end.

### 6.2 Replay mode

```
investigation.status ∈ { resolved, needs_review, failed, exported, ignored }
```

1. Call `buildReplayEventSequence(investigation, { isOperator, startPhase })`.
2. Stream events with `await sleep(intervalMs)` between each. Default `intervalMs = 80ms`.
3. `intervalMs` is derived from `?speed=` query param: `1` → 80ms, `5` → 16ms, `10` → 8ms.
4. `?startPhase=gather` skips events before the first `phase_start` for that phase. The skipped phases' final `budgetSnapshot` is injected into the first emitted event so the client initialises bars correctly.
5. End with `{ type: 'replay_complete' }`.

### 6.3 `buildReplayEventSequence`

```ts
function buildReplayEventSequence(
  investigation: Investigation,
  opts: { isOperator: boolean; startPhase?: Phase },
): InvestigationEvent[] {
  // Merge phaseHistory + toolCallLog + thinkingLog into canonical order:
  // phase_start → tool_call/tool_result pairs → thinking → phase_end
  // Filter thinking if !isOperator
  // Slice from startPhase if provided
}
```

Source fields on Investigation (added in proactive investigation design):
- `loopState.phaseHistory[]` — phase transitions with budgetSnapshot
- `loopState.toolCallLog[]` — full tool call + result log
- `loopState.thinkingLog[]` — thinking blocks per phase

### 6.4 Reconnection

Browser native `EventSource` reconnects on drop. Endpoint accepts `Last-Event-ID` header:
- Live mode: replays `toolCallLog` entries with `callIndex > lastEventId` before re-subscribing to EventBus.
- Replay mode: restarts from `callIndex > lastEventId`.

## 7. `loopState` additions

These fields are appended by the runner on every event so replay is always possible.

```ts
// extend Investigation.loopState

toolCallLog: Array<{
  callIndex: number;
  phase: Phase;
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
  durationMs: number;
  tokensUsed: number;
}>;

thinkingLog: Array<{
  phase: Phase;
  tokenCount: number;
  content: string;
}>;
```

`phaseHistory[]` already exists. Extend each entry with `summaryText: string` (the phase-end compaction summary from section 7.7 of the proactive investigation design).

## 8. Frontend — component tree

### 8.1 `useInvestigationStream` hook

```ts
// packages/app/src/hooks/useInvestigationStream.ts

function useInvestigationStream(investigationId: string, opts: { speed?: number; startPhase?: Phase }) {
  // opens EventSource('/api/investigations/:id/stream?speed=...&startPhase=...')
  // appends events to local state
  // derives: currentPhase, budgetSnapshot, phaseGroups, isReplay, isComplete
  // closes EventSource on investigation_complete / investigation_failed / replay_complete / unmount
  return { events, currentPhase, budgetSnapshot, phaseGroups, isReplay, isComplete, error };
}
```

### 8.2 `DebugDrawer`

Mantine `Drawer` (position=`right`, size=480). Opened by a "Debug" button in the investigation detail header — visible to all users.

```
┌─────────────────────────────────────────┐
│ Investigation Debug          [×]        │
│                                         │
│ ● LIVE  PaymentService error spike      │  ← status pill + title
│                                         │
│ Budget ████████░░ 8/12 tools            │  ← BudgetBar
│        ████░░░░░░ 9.2k/30k tokens       │
│        ──────────────── 01:24 elapsed   │
│                                         │
│ ✓ HYPOTHESIZE  0:12  1 tool             │  ← PhaseTimeline
│ ✓ GATHER       0:48  6 tools            │
│ ● CHALLENGE    0:24  2/3 tools          │
│ ○ REPORT                                │
│                                         │
│ ▼ CHALLENGE  (auto-expanded, active)    │  ← PhaseSection (Accordion)
│   ├─ searchTraces  0.6s  312 tok  ✓     │    ← ToolCallCard
│   │  service=payment window=2h          │
│   │  ▸ 1.2k spans, p99=4.8s, 38 errors  │
│   │                                     │
│   ├─ findSimilarErrors  1.1s  ●         │
│   │  [streaming...]                     │
│                                         │
│ ▶ GATHER  (collapsed)                   │
│ ▶ HYPOTHESIZE  (collapsed)              │
│                                         │
│ ── Operator ─────────────── [admin]     │  ← ThinkingBlock (isOperator only)
│ ▶ Reasoning: CHALLENGE  2 048 tok       │
│                                         │
│ [◀◀] [▶] [1×] [5×] [10×]  (replay)     │  ← ReplayControls (terminal only)
└─────────────────────────────────────────┘
```

### 8.3 `BudgetBar`

Two Mantine `Progress` bars + a wallclock ticker (`useInterval`, 1s tick):

- Tools: `consumedToolCalls / maxToolCalls` — turns orange at 75%, red at 90%
- Tokens: `consumedTokens / maxTokens` — same thresholds
- Wallclock: `elapsed / maxWallclockMs` displayed as `MM:SS elapsed`

### 8.4 `PhaseTimeline`

Four-item stepper (Mantine `Stepper`). Each item shows: phase name, duration (for completed phases), tool call count. Click a completed phase to collapse all others and expand that phase's `PhaseSection`.

### 8.5 `PhaseSection`

Mantine `Accordion.Item` per phase. Auto-expands the active phase; collapses on phase transition. Contains an ordered list of `ToolCallCard` components.

### 8.6 `ToolCallCard`

Mantine `Card` with:
- Header row: tool name, duration badge, token count badge, status icon (✓ / ● streaming / ✗ error)
- Args row: key=value pairs from the tool call args (flat, no nesting)
- Result row: compacted result rendered as a `Code` block (collapsed by default for completed phases, auto-expanded for the active card)
- Error state: red left border, error message in place of result

### 8.7 `ThinkingBlock`

Rendered only when `isOperator === true` (derived from session, passed as prop — never filtered client-side). Mantine `Accordion` at the drawer bottom, below a divider labelled "Operator". One item per phase that has a thinking entry. Shows: phase name, token count badge, full thinking content in a `ScrollArea` (max height 300px).

### 8.8 `ReplayControls`

Rendered only when `isReplay === true`. Controls:

| Control | Implementation |
|---|---|
| Play / Pause | Pauses client-side event drain: buffer incoming SSE events, stop rendering them |
| 1× / 5× / 10× | Closes `EventSource`, reopens with `?speed=N` |
| Jump to phase | Closes `EventSource`, reopens with `?startPhase=<phase>` |

## 9. Error handling

| Scenario | Behaviour |
|---|---|
| Runner crashes mid-run | 30s no-event timeout → synthetic `investigation_failed` → red banner in drawer |
| `pending` investigation opened | "Waiting for runner…" spinner; polls until `active` (max 20s), then streams |
| Network drop | `EventSource` auto-reconnects; `Last-Event-ID` sent; server replays missed events |
| Non-operator opens drawer | `thinking` events never sent from server; operator section hidden in UI |
| Tool call error (throws) | `tool_error` event → red-bordered `ToolCallCard` with error text; budget still increments |
| `failed` investigation opened | Replay runs to last recorded event → `investigation_failed` → red status banner with `lastError` |
| Multiple users watching | Each SSE connection is an independent EventBus listener; EventEmitter fan-out handles N connections |

## 10. Deferred to v1.1

- Download investigation trace as JSON
- Share a replay link with a team member (URL encodes `?startPhase=`, `?speed=`)
- Inline annotation on tool call results ("this was the key finding")
- Mobile-responsive drawer layout
