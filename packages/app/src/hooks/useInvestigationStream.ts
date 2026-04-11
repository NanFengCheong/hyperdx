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
  isReplay: boolean;
  isWaiting: boolean;
  thinkingByPhase: Record<string, { content: string; tokenCount: number }>;
  isPaused: boolean;
}

type StreamAction =
  | { type: 'connected' }
  | {
      type: 'phase_start';
      phase: LoopPhase;
      timestamp: number;
      budgetSnapshot?: BudgetSnapshot;
    }
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
  | {
      type: 'tool_call';
      callIndex: number;
      phase: string;
      tool: string;
      args: Record<string, unknown>;
      timestamp: number;
    }
  | {
      type: 'tool_result';
      callIndex: number;
      phase: string;
      tool: string;
      result: unknown;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: 'tool_error';
      callIndex: number;
      phase: string;
      tool: string;
      error: string;
      durationMs: number;
      timestamp: number;
    }
  | { type: 'waiting' }
  | { type: 'replay_start' }
  | { type: 'replay_complete' }
  | { type: 'thinking'; phase: string; content: string; tokenCount: number }
  | { type: 'set_paused'; paused: boolean }
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
    isReplay: false,
    isWaiting: false,
    thinkingByPhase: {},
    isPaused: false,
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
        ...(action.budgetSnapshot
          ? { budgetSnapshot: action.budgetSnapshot }
          : {}),
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
        ...(action.budgetSnapshot
          ? { budgetSnapshot: action.budgetSnapshot }
          : {}),
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
          ? {
              ...e,
              result: action.result,
              durationMs: action.durationMs,
              status: 'completed' as const,
            }
          : e,
      );
      return {
        ...state,
        toolCallsByPhase: {
          ...state.toolCallsByPhase,
          [action.phase]: updated,
        },
      };
    }

    case 'tool_error': {
      const entries = state.toolCallsByPhase[action.phase] ?? [];
      const updated = entries.map(e =>
        e.callIndex === action.callIndex
          ? {
              ...e,
              error: action.error,
              durationMs: action.durationMs,
              status: 'error' as const,
            }
          : e,
      );
      return {
        ...state,
        toolCallsByPhase: {
          ...state.toolCallsByPhase,
          [action.phase]: updated,
        },
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

    case 'waiting':
      return { ...state, isWaiting: true };

    case 'replay_start':
      return { ...state, isReplay: true, isWaiting: false };

    case 'replay_complete':
      return { ...state, isComplete: true };

    case 'thinking':
      return {
        ...state,
        thinkingByPhase: {
          ...state.thinkingByPhase,
          [action.phase]: {
            content: action.content,
            tokenCount: action.tokenCount,
          },
        },
      };

    case 'set_paused':
      return { ...state, isPaused: action.paused };

    case 'reset':
      return initialState();

    default:
      return state;
  }
}

interface UrlParams {
  speed: 1 | 5 | 10;
  startPhase: string | undefined;
}

export function useInvestigationStream(
  investigationId: string | null,
  _isOwner: boolean = false,
) {
  const [state, dispatch] = useReducer(streamReducer, undefined, initialState);
  const fetchRef = useRef<AbortController | null>(null);
  const urlParamsRef = useRef<UrlParams>({ speed: 1, startPhase: undefined });
  const pauseQueueRef = useRef<StreamAction[]>([]);
  const isPausedRef = useRef(false);

  const connect = useCallback(() => {
    if (!investigationId) return;

    fetchRef.current?.abort();
    const controller = new AbortController();
    fetchRef.current = controller;

    dispatch({ type: 'reset' });

    const { speed, startPhase } = urlParamsRef.current;
    const params = new URLSearchParams();
    if (speed !== 1) params.set('speed', String(speed));
    if (startPhase) params.set('startPhase', startPhase);
    const query = params.toString();
    const url = `/api/investigations/${investigationId}/stream${query ? `?${query}` : ''}`;

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
                  if (isPausedRef.current) {
                    pauseQueueRef.current.push(event);
                  } else {
                    dispatch(event);
                  }
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

  useEffect(() => {
    connect();
    return () => {
      fetchRef.current?.abort();
    };
  }, [connect]);

  useEffect(() => {
    if (state.isComplete) {
      fetchRef.current?.abort();
    }
  }, [state.isComplete]);

  const setSpeed = useCallback(
    (speed: 1 | 5 | 10) => {
      urlParamsRef.current = { ...urlParamsRef.current, speed };
      connect();
    },
    [connect],
  );

  const jumpToPhase = useCallback(
    (phase: string) => {
      urlParamsRef.current = { ...urlParamsRef.current, startPhase: phase };
      connect();
    },
    [connect],
  );

  const pause = useCallback(() => {
    isPausedRef.current = true;
    dispatch({ type: 'set_paused', paused: true });
  }, []);

  const resume = useCallback(() => {
    isPausedRef.current = false;
    const queued = pauseQueueRef.current.splice(0);
    for (const action of queued) {
      dispatch(action);
    }
    dispatch({ type: 'set_paused', paused: false });
  }, []);

  return {
    currentPhase: state.currentPhase,
    phaseGroups: state.phaseGroups,
    isComplete: state.isComplete,
    confidence: state.confidence,
    error: state.error,
    connected: state.connected,
    toolCallsByPhase: state.toolCallsByPhase,
    budgetSnapshot: state.budgetSnapshot,
    isReplay: state.isReplay,
    isWaiting: state.isWaiting,
    thinkingByPhase: state.thinkingByPhase,
    isPaused: state.isPaused,
    pause,
    resume,
    setSpeed,
    jumpToPhase,
  };
}
