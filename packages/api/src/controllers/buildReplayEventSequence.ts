import type { IInvestigation, LoopPhase } from '@/models/investigation';
import type { DebugEvent } from '@/utils/investigationEventBus';

const PHASES: LoopPhase[] = ['plan', 'execute', 'verify', 'summarize'];

export function buildReplayEventSequence(
  investigation: IInvestigation,
  opts: {
    isOwner: boolean;
    startPhase?: LoopPhase;
    lastEventId?: number;
  },
): DebugEvent[] {
  const events: DebugEvent[] = [];
  const loopState = investigation.loopState;
  if (!loopState) return events;

  const investigationId = investigation._id.toString();
  const startPhaseIndex = opts.startPhase ? PHASES.indexOf(opts.startPhase) : 0;

  let lastBudgetSnapshot = { toolCallsUsed: 0, toolCallsTotal: 22 };

  for (let phaseIdx = 0; phaseIdx < PHASES.length; phaseIdx++) {
    const phase = PHASES[phaseIdx];
    const phaseHistory = loopState.phaseHistory.find(h => h.phase === phase);

    if (phaseIdx < startPhaseIndex) {
      const phaseCalls = (loopState.toolCallLog || []).filter(
        t => t.phase === phase,
      );
      lastBudgetSnapshot = {
        toolCallsUsed: lastBudgetSnapshot.toolCallsUsed + phaseCalls.length,
        toolCallsTotal: 22,
      };
      continue;
    }

    const toolCallsInPhase = (loopState.toolCallLog || []).filter(
      t => t.phase === phase,
    );
    const phaseTimestamp = phaseHistory?.completedAt?.getTime() ?? Date.now();

    // phase_start
    events.push({
      type: 'phase_start',
      investigationId,
      phase,
      budgetSnapshot: { ...lastBudgetSnapshot },
      timestamp: phaseTimestamp,
    });

    // tool_call / tool_result or tool_error pairs ordered by callIndex
    const sortedCalls = [...toolCallsInPhase].sort(
      (a, b) => a.callIndex - b.callIndex,
    );
    for (const tc of sortedCalls) {
      events.push({
        type: 'tool_call',
        investigationId,
        callIndex: tc.callIndex,
        phase,
        tool: tc.tool,
        args: tc.args,
        timestamp: phaseTimestamp,
      });
      if (tc.error) {
        events.push({
          type: 'tool_error',
          investigationId,
          callIndex: tc.callIndex,
          phase,
          tool: tc.tool,
          error: tc.error,
          durationMs: tc.durationMs ?? 0,
          timestamp: phaseTimestamp,
        });
      } else {
        events.push({
          type: 'tool_result',
          investigationId,
          callIndex: tc.callIndex,
          phase,
          tool: tc.tool,
          result: tc.result,
          durationMs: tc.durationMs ?? 0,
          timestamp: phaseTimestamp,
        });
      }
    }

    // thinking (owner only)
    if (opts.isOwner) {
      const thinkingEntry = (loopState.thinkingLog || []).find(
        t => t.phase === phase,
      );
      if (thinkingEntry) {
        events.push({
          type: 'thinking',
          investigationId,
          phase,
          tokenCount: thinkingEntry.tokenCount,
          content: thinkingEntry.content,
          timestamp: phaseTimestamp,
        });
      }
    }

    const nextBudget = {
      toolCallsUsed: lastBudgetSnapshot.toolCallsUsed + toolCallsInPhase.length,
      toolCallsTotal: 22,
    };

    // phase_end
    events.push({
      type: 'phase_end',
      investigationId,
      phase,
      summaryText: phaseHistory?.summaryText ?? '',
      toolCallCount: toolCallsInPhase.length,
      budgetSnapshot: { ...nextBudget },
      timestamp: phaseTimestamp,
    });

    lastBudgetSnapshot = nextBudget;
  }

  // Terminal event
  const isResolved =
    investigation.status === 'resolved' || investigation.status === 'exported';
  if (isResolved) {
    events.push({
      type: 'investigation_complete',
      investigationId,
      confidence: 'high',
      timestamp: investigation.updatedAt?.getTime() ?? Date.now(),
    });
  } else {
    events.push({
      type: 'investigation_failed',
      investigationId,
      error: 'Investigation did not complete',
      timestamp: investigation.updatedAt?.getTime() ?? Date.now(),
    });
  }

  // Filter by lastEventId if provided (resume from position)
  if (opts.lastEventId !== undefined) {
    return events.slice(opts.lastEventId);
  }

  return events;
}
