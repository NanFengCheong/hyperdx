# Investigation Debug Visualization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream a real-time phase/tool-call debug panel into a side drawer on the investigation detail page, with full replay for finished investigations.

**Architecture:** Runner emits typed events to an in-process `InvestigationEventBus` (Node `EventEmitter`). A new SSE endpoint serves live events or replays from stored `loopState.toolCallLog`. The frontend streams via `EventSource` into a `DebugDrawer` composed of `BudgetBar`, `PhaseTimeline`, `PhaseSection`, `ToolCallCard`, `ThinkingBlock`, and `ReplayControls`.

**Tech Stack:** Node.js EventEmitter, Express SSE, React + Mantine UI, TanStack Query, `EventSource` browser API.

**Design doc:** `docs/plans/2026-04-11-investigation-debug-visualization-design.md` — read it before starting.

---

### Task 1: Extend `loopState` schema with `toolCallLog` and `thinkingLog`

**Files:**
- Modify: `packages/api/src/models/investigation.ts` (find the `loopState` sub-schema)
- Test: `packages/api/src/__tests__/models/investigation.test.ts`

**Step 1: Write the failing test**

```ts
it('saves toolCallLog and thinkingLog entries', async () => {
  const inv = await Investigation.create({
    team: new mongoose.Types.ObjectId(),
    title: 'test',
    status: 'active',
    loopState: {
      currentPhase: 'execute',
      phaseHistory: [],
      toolCallLog: [
        { callIndex: 0, phase: 'execute', tool: 'searchLogs',
          args: { service: 'api' }, result: { totalMatched: 5 },
          durationMs: 120, tokensUsed: 200 },
      ],
      thinkingLog: [
        { phase: 'verify', tokenCount: 1024, content: 'reasoning...' },
      ],
    },
  });
  expect(inv.loopState.toolCallLog).toHaveLength(1);
  expect(inv.loopState.toolCallLog[0].tool).toBe('searchLogs');
  expect(inv.loopState.thinkingLog[0].tokenCount).toBe(1024);
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/api
yarn ci:unit --testPathPattern="investigation.test"
```
Expected: FAIL — `toolCallLog` field not found on schema.

**Step 3: Add fields to the Mongoose schema**

In the `loopState` sub-schema, add:

```ts
toolCallLog: [
  new Schema({
    callIndex: { type: Number, required: true },
    phase: { type: String, required: true },
    tool: { type: String, required: true },
    args: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    durationMs: { type: Number, required: true },
    tokensUsed: { type: Number, default: 0 },
  }, { _id: false }),
],
thinkingLog: [
  new Schema({
    phase: { type: String, required: true },
    tokenCount: { type: Number, required: true },
    content: { type: String, required: true },
  }, { _id: false }),
],
```

Also extend each `phaseHistory` entry with `summaryText: { type: String }` if not already present.

**Step 4: Run test to verify it passes**

```bash
cd packages/api
yarn ci:unit --testPathPattern="investigation.test"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/models/investigation.ts packages/api/src/__tests__/models/investigation.test.ts
git commit -m "feat(investigation): add toolCallLog and thinkingLog to loopState schema"
```

---

### Task 2: Create `InvestigationEventBus`

**Files:**
- Create: `packages/api/src/lib/investigationEventBus.ts`
- Create: `packages/api/src/lib/__tests__/investigationEventBus.test.ts`

**Step 1: Write the failing test**

```ts
import { investigationEventBus } from '../investigationEventBus';

it('emits and receives typed events per investigationId', (done) => {
  const id = 'inv-123';
  investigationEventBus.once(id, (event) => {
    expect(event.type).toBe('tool_call');
    expect(event.tool).toBe('searchLogs');
    done();
  });
  investigationEventBus.emit(id, { type: 'tool_call', phase: 'execute', tool: 'searchLogs', args: {}, callIndex: 0 });
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/api
yarn ci:unit --testPathPattern="investigationEventBus"
```
Expected: FAIL — module not found.

**Step 3: Create the file**

```ts
// packages/api/src/lib/investigationEventBus.ts
import { EventEmitter } from 'node:events';

class InvestigationEventBus extends EventEmitter {}

export const investigationEventBus = new InvestigationEventBus();
investigationEventBus.setMaxListeners(100); // support N concurrent SSE connections
```

**Step 4: Run test to verify it passes**

```bash
cd packages/api
yarn ci:unit --testPathPattern="investigationEventBus"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/lib/investigationEventBus.ts packages/api/src/lib/__tests__/investigationEventBus.test.ts
git commit -m "feat(investigation): add InvestigationEventBus singleton"
```

---

### Task 3: Wire runner to emit events

**Files:**
- Modify: `packages/api/src/controllers/proactiveInvestigationRunner.ts`
- Test: `packages/api/src/__tests__/controllers/proactiveInvestigationRunner.test.ts`

**Step 1: Write the failing test**

```ts
it('emits phase_start and tool_call events during a run', async () => {
  const events: any[] = [];
  investigationEventBus.on(testInvId, (e) => events.push(e));

  await runInvestigation(mockInvestigation, mockConfig);

  const types = events.map((e) => e.type);
  expect(types).toContain('phase_start');
  expect(types).toContain('tool_call');
  expect(types).toContain('tool_result');
  expect(types).toContain('investigation_complete');
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/api
yarn ci:unit --testPathPattern="proactiveInvestigationRunner"
```
Expected: FAIL — no events emitted.

**Step 3: Add emit calls to the runner**

Import `investigationEventBus` and add emit calls at these points:

```ts
// Phase start
investigationEventBus.emit(investigation._id.toString(), {
  type: 'phase_start',
  phase: currentPhase,
  budgetSnapshot: getBudgetSnapshot(investigation),
});

// Before each tool call
investigationEventBus.emit(investigation._id.toString(), {
  type: 'tool_call', phase: currentPhase, tool: toolName, args, callIndex,
});

// After each tool result
investigationEventBus.emit(investigation._id.toString(), {
  type: 'tool_result', callIndex, result: compactedResult, durationMs, tokensUsed,
});

// On tool error
investigationEventBus.emit(investigation._id.toString(), {
  type: 'tool_error', callIndex, error: err.message, durationMs,
});

// Thinking block (when thinking mode is on)
investigationEventBus.emit(investigation._id.toString(), {
  type: 'thinking', phase: currentPhase, tokenCount, content: thinkingContent,
});

// Phase end
investigationEventBus.emit(investigation._id.toString(), {
  type: 'phase_end', phase: currentPhase, summaryText, budgetSnapshot: getBudgetSnapshot(investigation),
});

// Completion
investigationEventBus.emit(investigation._id.toString(), {
  type: investigation.status === 'failed' ? 'investigation_failed' : 'investigation_complete',
  status: investigation.status,
  artifactIds: investigation.artifacts ?? { savedSearchIds: [], dashboardIds: [], draftAlertIds: [] },
  error: investigation.lastError,
});
```

Also append each event's data to `loopState.toolCallLog` / `loopState.thinkingLog` and persist via `investigation.save()` after each phase.

Helper:

```ts
function getBudgetSnapshot(inv: Investigation): BudgetSnapshot {
  return {
    consumedToolCalls: inv.budget.consumedToolCalls,
    maxToolCalls: inv.budget.maxToolCalls,
    consumedTokens: inv.budget.consumedTokens,
    maxTokens: inv.budget.maxTokens,
    elapsedMs: Date.now() - inv.budget.startedAt.getTime(),
    maxWallclockMs: inv.budget.maxWallclockMs,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/api
yarn ci:unit --testPathPattern="proactiveInvestigationRunner"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/controllers/proactiveInvestigationRunner.ts \
        packages/api/src/__tests__/controllers/proactiveInvestigationRunner.test.ts
git commit -m "feat(investigation): emit debug events from runner via InvestigationEventBus"
```

---

### Task 4: `buildReplayEventSequence` utility

**Files:**
- Create: `packages/api/src/lib/buildReplayEventSequence.ts`
- Create: `packages/api/src/lib/__tests__/buildReplayEventSequence.test.ts`

**Step 1: Write the failing test**

```ts
import { buildReplayEventSequence } from '../buildReplayEventSequence';

const mockInvestigation = {
  status: 'resolved',
  loopState: {
    phaseHistory: [
      { phase: 'execute', startedAt: new Date(), endedAt: new Date(), summaryText: 'gathered evidence' },
    ],
    toolCallLog: [
      { callIndex: 0, phase: 'execute', tool: 'searchLogs', args: {}, result: { totalMatched: 5 }, durationMs: 100, tokensUsed: 200 },
    ],
    thinkingLog: [
      { phase: 'verify', tokenCount: 1024, content: 'reasoning...' },
    ],
  },
  artifacts: { savedSearchIds: [], dashboardIds: [], draftAlertIds: [] },
};

it('produces canonical event sequence', () => {
  const events = buildReplayEventSequence(mockInvestigation as any, { isOperator: true });
  const types = events.map((e) => e.type);
  expect(types).toContain('phase_start');
  expect(types).toContain('tool_call');
  expect(types).toContain('tool_result');
  expect(types).toContain('thinking');
  expect(types).toContain('investigation_complete');
});

it('strips thinking events for non-operators', () => {
  const events = buildReplayEventSequence(mockInvestigation as any, { isOperator: false });
  expect(events.find((e) => e.type === 'thinking')).toBeUndefined();
});

it('slices from startPhase', () => {
  const events = buildReplayEventSequence(mockInvestigation as any, { isOperator: false, startPhase: 'verify' });
  expect(events[0].type).toBe('phase_start');
  expect((events[0] as any).phase).toBe('verify');
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/api
yarn ci:unit --testPathPattern="buildReplayEventSequence"
```
Expected: FAIL — module not found.

**Step 3: Implement**

```ts
// packages/api/src/lib/buildReplayEventSequence.ts
export function buildReplayEventSequence(
  investigation: Investigation,
  opts: { isOperator: boolean; startPhase?: string },
): InvestigationEvent[] {
  const events: InvestigationEvent[] = [];
  const phases = investigation.loopState.phaseHistory ?? [];

  for (const phaseEntry of phases) {
    const phase = phaseEntry.phase;

    // phase_start
    events.push({ type: 'phase_start', phase, budgetSnapshot: phaseEntry.budgetSnapshotStart });

    // tool_call + tool_result pairs for this phase
    const calls = (investigation.loopState.toolCallLog ?? []).filter((c) => c.phase === phase);
    for (const call of calls) {
      events.push({ type: 'tool_call', phase, tool: call.tool, args: call.args, callIndex: call.callIndex });
      if (call.error) {
        events.push({ type: 'tool_error', callIndex: call.callIndex, error: call.error, durationMs: call.durationMs });
      } else {
        events.push({ type: 'tool_result', callIndex: call.callIndex, result: call.result, durationMs: call.durationMs, tokensUsed: call.tokensUsed });
      }
    }

    // thinking (operator-only)
    if (opts.isOperator) {
      const thinking = (investigation.loopState.thinkingLog ?? []).filter((t) => t.phase === phase);
      for (const t of thinking) {
        events.push({ type: 'thinking', phase, tokenCount: t.tokenCount, content: t.content });
      }
    }

    // phase_end
    events.push({ type: 'phase_end', phase, summaryText: phaseEntry.summaryText ?? '', budgetSnapshot: phaseEntry.budgetSnapshotEnd });
  }

  // terminal event
  if (investigation.status === 'failed') {
    events.push({ type: 'investigation_failed', error: investigation.lastError ?? 'unknown' });
  } else {
    events.push({ type: 'investigation_complete', status: investigation.status, artifactIds: investigation.artifacts });
  }

  // slice from startPhase
  if (opts.startPhase) {
    const startIdx = events.findIndex((e) => e.type === 'phase_start' && (e as any).phase === opts.startPhase);
    if (startIdx > 0) return events.slice(startIdx);
  }

  return events;
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/api
yarn ci:unit --testPathPattern="buildReplayEventSequence"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/lib/buildReplayEventSequence.ts \
        packages/api/src/lib/__tests__/buildReplayEventSequence.test.ts
git commit -m "feat(investigation): add buildReplayEventSequence for replay mode"
```

---

### Task 5: SSE endpoint — live mode

**Files:**
- Modify: `packages/api/src/routers/api/investigations.ts`
- Test: `packages/api/src/__tests__/routers/investigationStream.test.ts`

**Step 1: Write the failing test**

```ts
it('streams live events via SSE', async () => {
  // create an active investigation
  const inv = await createTestInvestigation({ status: 'active' });
  const res = await request(app)
    .get(`/api/investigations/${inv._id}/stream`)
    .set('Accept', 'text/event-stream')
    .buffer(false);

  // emit a test event
  setTimeout(() => {
    investigationEventBus.emit(inv._id.toString(), {
      type: 'tool_call', phase: 'execute', tool: 'searchLogs', args: {}, callIndex: 0,
    });
    investigationEventBus.emit(inv._id.toString(), { type: 'investigation_complete', status: 'resolved', artifactIds: {} });
  }, 50);

  const body = await collectSSE(res, { stopOn: 'investigation_complete' });
  expect(body.some((e: any) => e.type === 'tool_call')).toBe(true);
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/api
make dev-int FILE=investigationStream.test
```
Expected: FAIL — route not found.

**Step 3: Add the SSE route**

In `packages/api/src/routers/api/investigations.ts`:

```ts
router.get('/:id/stream', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { speed = '1', startPhase } = req.query as { speed?: string; startPhase?: string };
  const isOperator = req.user?.isOperator ?? false;
  const speedNum = Math.min(10, Math.max(1, parseInt(speed, 10)));
  const intervalMs = Math.round(80 / speedNum);

  const investigation = await Investigation.findOne({ _id: id, team: req.user.team });
  if (!investigation) return res.status(404).json({ error: 'not found' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: InvestigationEvent, eventIndex: number) => {
    res.write(`id: ${eventIndex}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  // REPLAY MODE — terminal status
  const terminalStatuses = ['resolved', 'needs_review', 'failed', 'exported', 'ignored'];
  if (terminalStatuses.includes(investigation.status)) {
    const events = buildReplayEventSequence(investigation, { isOperator, startPhase: startPhase as string });
    let idx = 0;
    for (const event of events) {
      if (res.destroyed) break;
      send(event, idx++);
      await sleep(intervalMs);
    }
    res.write(`data: ${JSON.stringify({ type: 'replay_complete' })}\n\n`);
    res.end();
    return;
  }

  // LIVE MODE
  // handle pending: poll until active
  let attempts = 0;
  while (investigation.status === 'pending' && attempts < 10) {
    res.write(`data: ${JSON.stringify({ type: 'waiting' })}\n\n`);
    await sleep(2000);
    await investigation.reload();
    attempts++;
  }

  let eventIndex = 0;

  // replay missed events since Last-Event-ID
  const lastEventId = parseInt(req.headers['last-event-id'] as string, 10);
  if (!isNaN(lastEventId)) {
    const missed = (investigation.loopState.toolCallLog ?? []).filter((c) => c.callIndex > lastEventId);
    for (const call of missed) {
      send({ type: 'tool_call', phase: call.phase as Phase, tool: call.tool, args: call.args, callIndex: call.callIndex }, eventIndex++);
      send({ type: 'tool_result', callIndex: call.callIndex, result: call.result, durationMs: call.durationMs, tokensUsed: call.tokensUsed }, eventIndex++);
    }
  }

  // subscribe to live events
  const listener = (event: InvestigationEvent) => {
    if (event.type === 'thinking' && !isOperator) return;
    send(event, eventIndex++);
    if (event.type === 'investigation_complete' || event.type === 'investigation_failed') {
      cleanup();
      res.end();
    }
  };

  // 30s no-event timeout
  let timeoutHandle = setTimeout(() => {
    send({ type: 'investigation_failed', error: 'runner_timeout' }, eventIndex++);
    cleanup();
    res.end();
  }, 30_000);

  const resetTimeout = () => {
    clearTimeout(timeoutHandle);
    timeoutHandle = setTimeout(() => {
      send({ type: 'investigation_failed', error: 'runner_timeout' }, eventIndex++);
      cleanup();
      res.end();
    }, 30_000);
  };

  const wrappedListener = (event: InvestigationEvent) => {
    resetTimeout();
    listener(event);
  };

  const cleanup = () => {
    clearTimeout(timeoutHandle);
    investigationEventBus.off(id, wrappedListener);
  };

  investigationEventBus.on(id, wrappedListener);
  req.on('close', cleanup);
});
```

**Step 4: Run test to verify it passes**

```bash
cd packages/api
make dev-int FILE=investigationStream.test
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/routers/api/investigations.ts \
        packages/api/src/__tests__/routers/investigationStream.test.ts
git commit -m "feat(investigation): add SSE stream endpoint with live and replay modes"
```

---

### Task 6: `useInvestigationStream` hook

**Files:**
- Create: `packages/app/src/hooks/useInvestigationStream.ts`
- Test: `packages/app/src/__tests__/hooks/useInvestigationStream.test.ts`

**Step 1: Write the failing test**

```ts
import { renderHook, act } from '@testing-library/react';
import { useInvestigationStream } from '../useInvestigationStream';

it('accumulates events and derives currentPhase', async () => {
  // mock EventSource
  const mockEvents = [
    { type: 'phase_start', phase: 'execute', budgetSnapshot: mockBudget },
    { type: 'tool_call', phase: 'execute', tool: 'searchLogs', args: {}, callIndex: 0 },
  ];
  setupMockEventSource(mockEvents);

  const { result } = renderHook(() =>
    useInvestigationStream('inv-123', {}),
  );

  await act(async () => { /* wait for events */ });

  expect(result.current.currentPhase).toBe('execute');
  expect(result.current.phaseGroups.execute.toolCalls).toHaveLength(1);
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/app
yarn ci:unit --testPathPattern="useInvestigationStream"
```
Expected: FAIL — module not found.

**Step 3: Implement the hook**

```ts
// packages/app/src/hooks/useInvestigationStream.ts
import { useEffect, useRef, useState } from 'react';

export type Phase = 'hypothesize' | 'gather' | 'challenge' | 'report';

export interface BudgetSnapshot {
  consumedToolCalls: number; maxToolCalls: number;
  consumedTokens: number; maxTokens: number;
  elapsedMs: number; maxWallclockMs: number;
}

export interface StreamState {
  events: any[];
  currentPhase: Phase | null;
  budgetSnapshot: BudgetSnapshot | null;
  phaseGroups: Record<string, { toolCalls: any[]; summaryText?: string; budgetSnapshot?: BudgetSnapshot }>;
  isReplay: boolean;
  isComplete: boolean;
  error: string | null;
}

export function useInvestigationStream(
  investigationId: string,
  opts: { speed?: number; startPhase?: Phase },
): StreamState {
  const [state, setState] = useState<StreamState>({
    events: [], currentPhase: null, budgetSnapshot: null,
    phaseGroups: {}, isReplay: false, isComplete: false, error: null,
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (opts.speed) params.set('speed', String(opts.speed));
    if (opts.startPhase) params.set('startPhase', opts.startPhase);
    const url = `/api/investigations/${investigationId}/stream?${params}`;

    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      setState((prev) => applyEvent(prev, event));
    };
    es.onerror = () => {
      setState((prev) => ({ ...prev, error: 'stream_error' }));
    };

    return () => { es.close(); };
  }, [investigationId, opts.speed, opts.startPhase]);

  return state;
}

function applyEvent(state: StreamState, event: any): StreamState {
  const events = [...state.events, event];
  let { currentPhase, budgetSnapshot, phaseGroups, isReplay, isComplete, error } = state;

  switch (event.type) {
    case 'phase_start':
      currentPhase = event.phase;
      budgetSnapshot = event.budgetSnapshot;
      phaseGroups = { ...phaseGroups, [event.phase]: { toolCalls: [] } };
      break;
    case 'tool_call':
      phaseGroups = {
        ...phaseGroups,
        [event.phase]: {
          ...phaseGroups[event.phase],
          toolCalls: [...(phaseGroups[event.phase]?.toolCalls ?? []), { ...event, result: null, durationMs: null }],
        },
      };
      break;
    case 'tool_result':
    case 'tool_error':
      phaseGroups = updateToolCallResult(phaseGroups, currentPhase!, event);
      break;
    case 'phase_end':
      budgetSnapshot = event.budgetSnapshot;
      phaseGroups = { ...phaseGroups, [event.phase]: { ...phaseGroups[event.phase], summaryText: event.summaryText, budgetSnapshot: event.budgetSnapshot } };
      break;
    case 'investigation_complete':
    case 'investigation_failed':
      isComplete = true;
      if (event.type === 'investigation_failed') error = event.error;
      break;
    case 'replay_complete':
      isReplay = true;
      isComplete = true;
      break;
  }

  return { events, currentPhase, budgetSnapshot, phaseGroups, isReplay, isComplete, error };
}

function updateToolCallResult(phaseGroups: any, phase: Phase, event: any) {
  const group = phaseGroups[phase];
  if (!group) return phaseGroups;
  const toolCalls = group.toolCalls.map((tc: any) =>
    tc.callIndex === event.callIndex ? { ...tc, result: event.result, error: event.error, durationMs: event.durationMs, tokensUsed: event.tokensUsed } : tc,
  );
  return { ...phaseGroups, [phase]: { ...group, toolCalls } };
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/app
yarn ci:unit --testPathPattern="useInvestigationStream"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/hooks/useInvestigationStream.ts \
        packages/app/src/__tests__/hooks/useInvestigationStream.test.ts
git commit -m "feat(investigation): add useInvestigationStream hook"
```

---

### Task 7: `BudgetBar` component

**Files:**
- Create: `packages/app/src/components/investigation/BudgetBar.tsx`
- Test: `packages/app/src/__tests__/components/investigation/BudgetBar.test.tsx`

**Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { BudgetBar } from '../BudgetBar';

const mockBudget = {
  consumedToolCalls: 8, maxToolCalls: 12,
  consumedTokens: 9200, maxTokens: 30000,
  elapsedMs: 84000, maxWallclockMs: 240000,
};

it('renders tool and token progress', () => {
  render(<BudgetBar budget={mockBudget} />);
  expect(screen.getByText(/8\/12 tools/)).toBeInTheDocument();
  expect(screen.getByText(/9\.2k\/30k tokens/)).toBeInTheDocument();
});

it('turns orange at 75% tool usage', () => {
  render(<BudgetBar budget={{ ...mockBudget, consumedToolCalls: 9 }} />);
  // check color class/prop — implementation-specific
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/app
yarn ci:unit --testPathPattern="BudgetBar"
```
Expected: FAIL — module not found.

**Step 3: Implement**

```tsx
// packages/app/src/components/investigation/BudgetBar.tsx
import { Progress, Stack, Text, Group } from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { useState } from 'react';
import type { BudgetSnapshot } from '../../../hooks/useInvestigationStream';

function colorForRatio(ratio: number) {
  if (ratio >= 0.9) return 'red';
  if (ratio >= 0.75) return 'orange';
  return 'blue';
}

function formatTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatMs(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function BudgetBar({ budget, isLive = false }: { budget: BudgetSnapshot; isLive?: boolean }) {
  const [elapsed, setElapsed] = useState(budget.elapsedMs);
  useInterval(() => setElapsed((e) => e + 1000), isLive ? 1000 : null);

  const toolRatio = budget.consumedToolCalls / budget.maxToolCalls;
  const tokenRatio = budget.consumedTokens / budget.maxTokens;

  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Tools</Text>
        <Text size="xs">{budget.consumedToolCalls}/{budget.maxToolCalls}</Text>
      </Group>
      <Progress value={toolRatio * 100} color={colorForRatio(toolRatio)} size="sm" />

      <Group justify="space-between">
        <Text size="xs" c="dimmed">Tokens</Text>
        <Text size="xs">{formatTokens(budget.consumedTokens)}/{formatTokens(budget.maxTokens)}</Text>
      </Group>
      <Progress value={tokenRatio * 100} color={colorForRatio(tokenRatio)} size="sm" />

      <Text size="xs" c="dimmed">{formatMs(elapsed)} elapsed</Text>
    </Stack>
  );
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/app
yarn ci:unit --testPathPattern="BudgetBar"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/components/investigation/BudgetBar.tsx \
        packages/app/src/__tests__/components/investigation/BudgetBar.test.tsx
git commit -m "feat(investigation): add BudgetBar component"
```

---

### Task 8: `ToolCallCard` component

**Files:**
- Create: `packages/app/src/components/investigation/ToolCallCard.tsx`
- Test: `packages/app/src/__tests__/components/investigation/ToolCallCard.test.tsx`

**Step 1: Write the failing test**

```tsx
it('renders tool name, duration, and result', () => {
  render(<ToolCallCard call={{
    callIndex: 0, phase: 'execute', tool: 'searchLogs',
    args: { service: 'api', window: '1h' },
    result: { totalMatched: 847, topN: [] },
    durationMs: 320, tokensUsed: 210,
  }} />);
  expect(screen.getByText('searchLogs')).toBeInTheDocument();
  expect(screen.getByText(/320ms/)).toBeInTheDocument();
  expect(screen.getByText(/210 tok/)).toBeInTheDocument();
});

it('renders error state with red styling', () => {
  render(<ToolCallCard call={{ callIndex: 0, phase: 'execute', tool: 'searchLogs', args: {}, error: 'timeout', durationMs: 5000, tokensUsed: 0 }} />);
  expect(screen.getByText(/timeout/)).toBeInTheDocument();
});

it('shows streaming indicator when result is null', () => {
  render(<ToolCallCard call={{ callIndex: 0, phase: 'execute', tool: 'searchLogs', args: {}, result: null, durationMs: null, tokensUsed: null }} />);
  expect(screen.getByText(/streaming/i)).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/app
yarn ci:unit --testPathPattern="ToolCallCard"
```
Expected: FAIL — module not found.

**Step 3: Implement**

```tsx
// packages/app/src/components/investigation/ToolCallCard.tsx
import { Card, Badge, Code, Text, Group, Stack, Collapse } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';

interface ToolCall {
  callIndex: number; phase: string; tool: string;
  args: Record<string, unknown>;
  result?: unknown; error?: string;
  durationMs: number | null; tokensUsed: number | null;
}

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, { toggle }] = useDisclosure(call.result === null); // auto-open while streaming
  const isStreaming = call.result === null && !call.error;
  const isError = !!call.error;

  return (
    <Card
      p="xs"
      radius="sm"
      withBorder
      style={{ borderLeft: isError ? '3px solid var(--mantine-color-red-6)' : undefined }}
    >
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap">
          <Text fw={500} size="sm">{call.tool}</Text>
          <Group gap={4}>
            {call.durationMs != null && <Badge size="xs" variant="outline">{call.durationMs}ms</Badge>}
            {call.tokensUsed != null && <Badge size="xs" variant="outline" color="gray">{call.tokensUsed} tok</Badge>}
            {isStreaming && <Badge size="xs" color="blue">streaming...</Badge>}
            {isError && <Badge size="xs" color="red">error</Badge>}
          </Group>
        </Group>

        {/* Args */}
        <Text size="xs" c="dimmed" style={{ cursor: 'pointer' }} onClick={toggle}>
          {Object.entries(call.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')}
        </Text>

        {/* Result / Error */}
        <Collapse in={open}>
          {isError ? (
            <Text size="xs" c="red">{call.error}</Text>
          ) : call.result != null ? (
            <Code block style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(call.result, null, 2)}
            </Code>
          ) : null}
        </Collapse>
      </Stack>
    </Card>
  );
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/app
yarn ci:unit --testPathPattern="ToolCallCard"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/components/investigation/ToolCallCard.tsx \
        packages/app/src/__tests__/components/investigation/ToolCallCard.test.tsx
git commit -m "feat(investigation): add ToolCallCard component"
```

---

### Task 9: `PhaseSection` and `PhaseTimeline` components

**Files:**
- Create: `packages/app/src/components/investigation/PhaseSection.tsx`
- Create: `packages/app/src/components/investigation/PhaseTimeline.tsx`
- Test: `packages/app/src/__tests__/components/investigation/PhaseSection.test.tsx`

**Step 1: Write the failing test**

```tsx
it('renders tool calls inside the phase section', () => {
  render(<PhaseSection phase="execute" isActive toolCalls={[mockToolCall]} summaryText="" />);
  expect(screen.getByText('searchLogs')).toBeInTheDocument();
});

it('timeline shows active phase with spinner', () => {
  render(<PhaseTimeline currentPhase="execute" phaseGroups={mockPhaseGroups} onPhaseClick={jest.fn()} />);
  expect(screen.getByText('gather')).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/app
yarn ci:unit --testPathPattern="PhaseSection"
```
Expected: FAIL — module not found.

**Step 3: Implement both**

```tsx
// packages/app/src/components/investigation/PhaseSection.tsx
import { Accordion, Text, Stack, Badge } from '@mantine/core';
import { ToolCallCard } from './ToolCallCard';

const PHASE_LABELS: Record<string, string> = {
  hypothesize: 'HYPOTHESIZE', gather: 'GATHER', challenge: 'CHALLENGE', report: 'REPORT',
};

export function PhaseSection({ phase, isActive, toolCalls, summaryText }: {
  phase: string; isActive: boolean; toolCalls: any[]; summaryText?: string;
}) {
  return (
    <Accordion.Item value={phase}>
      <Accordion.Control>
        <Text fw={isActive ? 700 : 400} size="sm">
          {PHASE_LABELS[phase] ?? phase.toUpperCase()}
          {isActive && <Badge ml={8} size="xs" color="blue">active</Badge>}
          <Text span size="xs" c="dimmed" ml={8}>{toolCalls.length} tools</Text>
        </Text>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap={6}>
          {toolCalls.map((tc) => <ToolCallCard key={tc.callIndex} call={tc} />)}
          {summaryText && <Text size="xs" c="dimmed" mt={4}>{summaryText}</Text>}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
```

```tsx
// packages/app/src/components/investigation/PhaseTimeline.tsx
import { Stepper, Text } from '@mantine/core';

const PHASES = ['hypothesize', 'gather', 'challenge', 'report'] as const;

export function PhaseTimeline({ currentPhase, phaseGroups, onPhaseClick }: {
  currentPhase: string | null;
  phaseGroups: Record<string, any>;
  onPhaseClick: (phase: string) => void;
}) {
  const activeIndex = PHASES.indexOf(currentPhase as any);

  return (
    <Stepper active={activeIndex} size="xs" orientation="horizontal">
      {PHASES.map((phase) => {
        const group = phaseGroups[phase];
        return (
          <Stepper.Step
            key={phase}
            label={<Text size="xs" style={{ cursor: group ? 'pointer' : 'default' }} onClick={() => group && onPhaseClick(phase)}>{phase}</Text>}
            description={group ? `${group.toolCalls?.length ?? 0} tools` : undefined}
          />
        );
      })}
    </Stepper>
  );
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/app
yarn ci:unit --testPathPattern="PhaseSection"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/components/investigation/PhaseSection.tsx \
        packages/app/src/components/investigation/PhaseTimeline.tsx \
        packages/app/src/__tests__/components/investigation/PhaseSection.test.tsx
git commit -m "feat(investigation): add PhaseSection and PhaseTimeline components"
```

---

### Task 10: `ThinkingBlock` and `ReplayControls` components

**Files:**
- Create: `packages/app/src/components/investigation/ThinkingBlock.tsx`
- Create: `packages/app/src/components/investigation/ReplayControls.tsx`
- Test: `packages/app/src/__tests__/components/investigation/ThinkingBlock.test.tsx`

**Step 1: Write the failing test**

```tsx
it('renders thinking content in a scrollarea', () => {
  render(<ThinkingBlock thinkingLog={[{ phase: 'verify', tokenCount: 1024, content: 'I think...' }]} />);
  expect(screen.getByText(/I think/)).toBeInTheDocument();
  expect(screen.getByText(/1 024 tok/)).toBeInTheDocument();
});

it('replay controls call onSpeedChange', async () => {
  const onSpeedChange = jest.fn();
  render(<ReplayControls speed={1} isPlaying onSpeedChange={onSpeedChange} onPhaseJump={jest.fn()} onTogglePlay={jest.fn()} />);
  await userEvent.click(screen.getByText('5×'));
  expect(onSpeedChange).toHaveBeenCalledWith(5);
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/app
yarn ci:unit --testPathPattern="ThinkingBlock"
```
Expected: FAIL — module not found.

**Step 3: Implement both**

```tsx
// packages/app/src/components/investigation/ThinkingBlock.tsx
import { Accordion, ScrollArea, Code, Badge, Text, Divider } from '@mantine/core';

export function ThinkingBlock({ thinkingLog }: { thinkingLog: Array<{ phase: string; tokenCount: number; content: string }> }) {
  if (!thinkingLog.length) return null;
  return (
    <>
      <Divider label="Operator" labelPosition="center" my="xs" />
      <Accordion variant="contained" radius="sm">
        {thinkingLog.map((t, i) => (
          <Accordion.Item key={i} value={`thinking-${i}`}>
            <Accordion.Control>
              <Text size="xs">Reasoning: {t.phase} <Badge size="xs" ml={4}>{t.tokenCount.toLocaleString()} tok</Badge></Text>
            </Accordion.Control>
            <Accordion.Panel>
              <ScrollArea h={300}>
                <Code block style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{t.content}</Code>
              </ScrollArea>
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </>
  );
}
```

```tsx
// packages/app/src/components/investigation/ReplayControls.tsx
import { Group, ActionIcon, Button, Text } from '@mantine/core';
import { IconPlayerPlay, IconPlayerPause, IconPlayerSkipBack } from '@tabler/icons-react';

const SPEEDS = [1, 5, 10] as const;
const PHASES = ['hypothesize', 'gather', 'challenge', 'report'] as const;

export function ReplayControls({ speed, isPlaying, onSpeedChange, onPhaseJump, onTogglePlay }: {
  speed: number; isPlaying: boolean;
  onSpeedChange: (s: number) => void;
  onPhaseJump: (phase: string) => void;
  onTogglePlay: () => void;
}) {
  return (
    <Group gap={6} mt="xs">
      <ActionIcon variant="subtle" onClick={onTogglePlay} title={isPlaying ? 'Pause' : 'Play'}>
        {isPlaying ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
      </ActionIcon>
      {SPEEDS.map((s) => (
        <Button key={s} size="compact-xs" variant={speed === s ? 'filled' : 'subtle'} onClick={() => onSpeedChange(s)}>
          {s}×
        </Button>
      ))}
      <Text size="xs" c="dimmed">Jump:</Text>
      {PHASES.map((p) => (
        <Button key={p} size="compact-xs" variant="subtle" onClick={() => onPhaseJump(p)}>
          {p.slice(0, 3)}
        </Button>
      ))}
    </Group>
  );
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/app
yarn ci:unit --testPathPattern="ThinkingBlock"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/components/investigation/ThinkingBlock.tsx \
        packages/app/src/components/investigation/ReplayControls.tsx \
        packages/app/src/__tests__/components/investigation/ThinkingBlock.test.tsx
git commit -m "feat(investigation): add ThinkingBlock and ReplayControls components"
```

---

### Task 11: `DebugDrawer` — wire everything together

**Files:**
- Create: `packages/app/src/components/investigation/DebugDrawer.tsx`
- Test: `packages/app/src/__tests__/components/investigation/DebugDrawer.test.tsx`

**Step 1: Write the failing test**

```tsx
it('opens drawer and shows budget bars', async () => {
  setupMockEventSource([
    { type: 'phase_start', phase: 'execute', budgetSnapshot: mockBudget },
  ]);
  render(<DebugDrawer investigationId="inv-123" isOperator={false} />);
  await userEvent.click(screen.getByRole('button', { name: /debug/i }));
  expect(await screen.findByText(/0\/12 tools/)).toBeInTheDocument();
});
```

**Step 2: Run test to verify it fails**

```bash
cd packages/app
yarn ci:unit --testPathPattern="DebugDrawer"
```
Expected: FAIL — module not found.

**Step 3: Implement**

```tsx
// packages/app/src/components/investigation/DebugDrawer.tsx
import { Drawer, Button, Stack, Accordion, Text, Badge, Group } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useState } from 'react';
import { useInvestigationStream, type Phase } from '../../../hooks/useInvestigationStream';
import { BudgetBar } from './BudgetBar';
import { PhaseTimeline } from './PhaseTimeline';
import { PhaseSection } from './PhaseSection';
import { ThinkingBlock } from './ThinkingBlock';
import { ReplayControls } from './ReplayControls';

export function DebugDrawer({ investigationId, isOperator }: { investigationId: string; isOperator: boolean }) {
  const [opened, { open, close }] = useDisclosure(false);
  const [speed, setSpeed] = useState(1);
  const [startPhase, setStartPhase] = useState<Phase | undefined>();
  const [isPlaying, setIsPlaying] = useState(true);

  const { currentPhase, budgetSnapshot, phaseGroups, isReplay, isComplete, error, events } =
    useInvestigationStream(investigationId, { speed: isPlaying ? speed : 0, startPhase });

  const thinkingLog = events.filter((e: any) => e.type === 'thinking');
  const orderedPhases = ['hypothesize', 'gather', 'challenge', 'report'] as const;
  const activePhases = orderedPhases.filter((p) => phaseGroups[p]);

  return (
    <>
      <Button size="xs" variant="subtle" onClick={open}>Debug</Button>
      <Drawer
        opened={opened}
        onClose={close}
        position="right"
        size={480}
        title={
          <Group gap={8}>
            <Badge color={isComplete ? 'gray' : 'green'} variant="dot">
              {isComplete ? (isReplay ? 'Replay' : 'Complete') : 'Live'}
            </Badge>
            <Text size="sm" fw={500} truncate>Investigation Debug</Text>
          </Group>
        }
      >
        <Stack gap="md" p="xs">
          {budgetSnapshot && (
            <BudgetBar budget={budgetSnapshot} isLive={!isComplete} />
          )}

          <PhaseTimeline
            currentPhase={currentPhase}
            phaseGroups={phaseGroups}
            onPhaseClick={(p) => setStartPhase(p as Phase)}
          />

          {error && <Text c="red" size="sm">{error}</Text>}

          <Accordion multiple defaultValue={currentPhase ? [currentPhase] : []}>
            {activePhases.map((phase) => (
              <PhaseSection
                key={phase}
                phase={phase}
                isActive={currentPhase === phase}
                toolCalls={phaseGroups[phase]?.toolCalls ?? []}
                summaryText={phaseGroups[phase]?.summaryText}
              />
            ))}
          </Accordion>

          {isOperator && thinkingLog.length > 0 && (
            <ThinkingBlock thinkingLog={thinkingLog} />
          )}

          {isReplay && (
            <ReplayControls
              speed={speed}
              isPlaying={isPlaying}
              onSpeedChange={(s) => { setSpeed(s); }}
              onPhaseJump={(p) => setStartPhase(p as Phase)}
              onTogglePlay={() => setIsPlaying((v) => !v)}
            />
          )}
        </Stack>
      </Drawer>
    </>
  );
}
```

**Step 4: Run test to verify it passes**

```bash
cd packages/app
yarn ci:unit --testPathPattern="DebugDrawer"
```
Expected: PASS

**Step 5: Commit**

```bash
git add packages/app/src/components/investigation/DebugDrawer.tsx \
        packages/app/src/__tests__/components/investigation/DebugDrawer.test.tsx
git commit -m "feat(investigation): add DebugDrawer — wires stream, budget, phases, replay"
```

---

### Task 12: Wire `DebugDrawer` into the investigation detail page

**Files:**
- Modify: find the investigation detail page component (search for `InvestigationDetail` or the route rendering investigation messages in `packages/app/src/`)
- Test: existing investigation detail tests

**Step 1: Find the investigation detail component**

```bash
grep -r "InvestigationDetail\|investigation.*messages\|loopState" packages/app/src --include="*.tsx" -l
```

**Step 2: Add Debug button to the investigation header**

In the investigation detail component, import and add `DebugDrawer` next to the existing action buttons in the header:

```tsx
import { DebugDrawer } from '../components/investigation/DebugDrawer';

// In JSX header area:
<DebugDrawer
  investigationId={investigation._id}
  isOperator={currentUser?.isOperator ?? false}
/>
```

**Step 3: Verify `isOperator` is available on the current user session**

Check `currentUser` type in `packages/app/src/` — if `isOperator` is not there, add it to the user session type (it should come from the API's `req.user`; add it to the user serialisation in `packages/api/src/middleware/auth.ts` if missing).

**Step 4: Run existing tests**

```bash
cd packages/app
yarn ci:unit
```
Expected: all existing tests still PASS.

**Step 5: Commit**

```bash
git add packages/app/src/  # specific file path once found
git commit -m "feat(investigation): wire DebugDrawer into investigation detail page"
```

---

### Task 13: Lint, type-check, final validation

**Step 1: Run lint and type check**

```bash
make ci-lint
```
Expected: no errors.

**Step 2: Run all unit tests**

```bash
make ci-unit
```
Expected: all PASS.

**Step 3: Run integration test for SSE endpoint**

```bash
cd packages/api
make dev-int FILE=investigationStream.test
```
Expected: PASS.

**Step 4: Commit if any lint fixes were auto-applied**

```bash
git add -p
git commit -m "chore: lint fixes for investigation debug visualization"
```
