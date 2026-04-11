import { useCallback, useEffect, useReducer, useRef } from 'react';

export type LoopPhase = 'plan' | 'execute' | 'verify' | 'summarize';

export interface PhaseGroup {
  phase: LoopPhase;
  status: 'active' | 'completed' | 'pending';
  summaryText?: string;
  toolCallCount?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ToolCallEntry {
  callIndex: number;
  phase: LoopPhase;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  status: 'pending' | 'completed' | 'error';
}

export interface BudgetSnapshot {
  toolCallsUsed: number;
  toolCallsTotal: number;
}

interface StreamState {
  currentPhase: LoopPhase | null;
  phaseGroups: PhaseGroup[];
  isComplete: boolean;
  confidence?: 'high' | 'medium' | 'low';
  error?: string;
  connected: boolean;
  toolCallsByPhase: Record<string, ToolCallEntry[]>;
  budgetSnapshot?: BudgetSnapshot;
}

type StreamAction =
  | { type: 'connected' }
  | { type: 'phase_start'; phase: LoopPhase; timestamp: number; budgetSnapshot?: BudgetSnapshot }
  | {
      type: 'phase_end';
      phase: LoopPhase;
      summaryText: string;
      toolCallCount: number;
      timestamp: number;
      budgetSnapshot?: BudgetSnapshot;
    }
  | { type: 'investigation_complete'; confidence: 'high' | 'medium' | 'low' }
  | { type: 'investigation_failed'; error: string }
  | { type: 'tool_call'; callIndex: number; phase: string; tool: string; args: Record<string, unknown>; timestamp: number }
  | { type: 'tool_result'; callIndex: number; phase: string; tool: string; result: unknown; durationMs: number; timestamp: number }
  | { type: 'tool_error'; callIndex: number; phase: string; tool: string; error: string; durationMs: number; timestamp: number }
  | { type: 'reset' };

const ALL_PHASES: LoopPhase[] = ['plan', 'execute', 'verify', 'summarize'];

function initialState(): StreamState {
  return {
    currentPhase: null,
    phaseGroups: ALL_PHASES.map(phase => ({
      phase,
      status: 'pending' as const,
    })),
    isComplete: false,
    connected: false,
    toolCallsByPhase: {},
  };
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'connected':
      return { ...state, connected: true };

    case 'phase_start': {
      const phaseGroups = state.phaseGroups.map(pg =>
        pg.phase === action.phase
          ? { ...pg, status: 'active' as const, startedAt: action.timestamp }
          : pg,
      );
      return {
        ...state,
        currentPhase: action.phase,
        phaseGroups,
        ...(action.budgetSnapshot ? { budgetSnapshot: action.budgetSnapshot } : {}),
      };
    }

    case 'phase_end': {
      const phaseGroups = state.phaseGroups.map(pg =>
        pg.phase === action.phase
          ? {
              ...pg,
              status: 'completed' as const,
              summaryText: action.summaryText,
              toolCallCount: action.toolCallCount,
              completedAt: action.timestamp,
            }
          : pg,
      );
      return {
        ...state,
        phaseGroups,
        ...(action.budgetSnapshot ? { budgetSnapshot: action.budgetSnapshot } : {}),
      };
    }

    case 'tool_call': {
      const entry: ToolCallEntry = {
        callIndex: action.callIndex,
        phase: action.phase as LoopPhase,
        tool: action.tool,
        args: action.args,
        status: 'pending',
      };
      const existing = state.toolCallsByPhase[action.phase] ?? [];
      return {
        ...state,
        toolCallsByPhase: {
          ...state.toolCallsByPhase,
          [action.phase]: [...existing, entry],
        },
      };
    }

    case 'tool_result': {
      const entries = state.toolCallsByPhase[action.phase] ?? [];
      const updated = entries.map(e =>
        e.callIndex === action.callIndex
          ? { ...e, result: action.result, durationMs: action.durationMs, status: 'completed' as const }
          : e,
      );
      return {
        ...state,
        toolCallsByPhase: { ...state.toolCallsByPhase, [action.phase]: updated },
      };
    }

    case 'tool_error': {
      const entries = state.toolCallsByPhase[action.phase] ?? [];
      const updated = entries.map(e =>
        e.callIndex === action.callIndex
          ? { ...e, error: action.error, durationMs: action.durationMs, status: 'error' as const }
          : e,
      );
      return {
        ...state,
        toolCallsByPhase: { ...state.toolCallsByPhase, [action.phase]: updated },
      };
    }

    case 'investigation_complete':
      return {
        ...state,
        isComplete: true,
        currentPhase: null,
        confidence: action.confidence,
      };

    case 'investigation_failed':
      return { ...state, isComplete: true, error: action.error };

    case 'reset':
      return initialState();

    default:
      return state;
  }
}

export function useInvestigationStream(investigationId: string | null) {
  const [state, dispatch] = useReducer(streamReducer, undefined, initialState);
  const fetchRef = useRef<AbortController | null>(null);

  const connect = useCallback(() => {
    if (!investigationId) return;

    // Abort any existing connection
    fetchRef.current?.abort();
    const controller = new AbortController();
    fetchRef.current = controller;

    dispatch({ type: 'reset' });

    const url = `/api/investigations/${investigationId}/stream`;

    fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })
      .then(response => {
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        function pump(): Promise<void> {
          return reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const event = JSON.parse(line.slice(6));
                  dispatch(event);
                } catch {
                  // ignore parse errors
                }
              }
            }
            return pump();
          });
        }

        return pump();
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          dispatch({ type: 'investigation_failed', error: err.message });
        }
      });
  }, [investigationId]);

  // Reconnect when investigationId changes
  useEffect(() => {
    connect();
    return () => {
      fetchRef.current?.abort();
    };
  }, [connect]);

  // Close stream when complete
  useEffect(() => {
    if (state.isComplete) {
      fetchRef.current?.abort();
    }
  }, [state.isComplete]);

  return {
    currentPhase: state.currentPhase,
    phaseGroups: state.phaseGroups,
    isComplete: state.isComplete,
    confidence: state.confidence,
    error: state.error,
    connected: state.connected,
    toolCallsByPhase: state.toolCallsByPhase,
    budgetSnapshot: state.budgetSnapshot,
  };
}
