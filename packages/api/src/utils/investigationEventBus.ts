/**
 * In-process EventBus for real-time investigation phase/tool events.
 * Single-replica assumption: pub/sub is local EventEmitter only.
 * For multi-replica deployments, replace with Redis pub/sub.
 */
import { EventEmitter } from 'events';

export type DebugEventType =
  | 'phase_start'
  | 'phase_end'
  | 'investigation_complete'
  | 'investigation_failed'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'thinking'
  | 'waiting'
  | 'replay_start'
  | 'replay_complete'
  | 'connected';

export interface BudgetSnapshot {
  toolCallsUsed: number;
  toolCallsTotal: number;
}

export interface PhaseStartEvent {
  type: 'phase_start';
  investigationId: string;
  phase: string;
  budgetSnapshot?: BudgetSnapshot;
  timestamp: number;
}

export interface PhaseEndEvent {
  type: 'phase_end';
  investigationId: string;
  phase: string;
  summaryText: string;
  toolCallCount: number;
  budgetSnapshot?: BudgetSnapshot;
  timestamp: number;
}

export interface ToolCallEvent {
  type: 'tool_call';
  investigationId: string;
  callIndex: number;
  phase: string;
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface ToolResultEvent {
  type: 'tool_result';
  investigationId: string;
  callIndex: number;
  phase: string;
  tool: string;
  result: unknown;
  durationMs: number;
  timestamp: number;
}

export interface ToolErrorEvent {
  type: 'tool_error';
  investigationId: string;
  callIndex: number;
  phase: string;
  tool: string;
  error: string;
  durationMs: number;
  timestamp: number;
}

export interface InvestigationCompleteEvent {
  type: 'investigation_complete';
  investigationId: string;
  confidence: 'high' | 'medium' | 'low';
  timestamp: number;
}

export interface InvestigationFailedEvent {
  type: 'investigation_failed';
  investigationId: string;
  error: string;
  timestamp: number;
}

export interface ThinkingEvent {
  type: 'thinking';
  investigationId: string;
  phase: string;
  tokenCount: number;
  content: string;
  timestamp: number;
}

export interface WaitingEvent {
  type: 'waiting';
  investigationId: string;
  timestamp: number;
}

export interface ReplayStartEvent {
  type: 'replay_start';
  investigationId: string;
  timestamp: number;
}

export interface ReplayCompleteEvent {
  type: 'replay_complete';
  investigationId: string;
  timestamp: number;
}

export interface ConnectedEvent {
  type: 'connected';
  investigationId: string;
}

export type DebugEvent =
  | PhaseStartEvent
  | PhaseEndEvent
  | InvestigationCompleteEvent
  | InvestigationFailedEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ThinkingEvent
  | WaitingEvent
  | ReplayStartEvent
  | ReplayCompleteEvent
  | ConnectedEvent;

class InvestigationEventBus extends EventEmitter {
  private static instance: InvestigationEventBus;

  private constructor() {
    super();
    this.setMaxListeners(200); // Support many concurrent SSE clients
  }

  static getInstance(): InvestigationEventBus {
    if (!InvestigationEventBus.instance) {
      InvestigationEventBus.instance = new InvestigationEventBus();
    }
    return InvestigationEventBus.instance;
  }

  emitDebugEvent(event: DebugEvent): void {
    this.emit(`investigation:${event.investigationId}`, event);
  }

  subscribeToInvestigation(
    investigationId: string,
    handler: (event: DebugEvent) => void,
  ): () => void {
    const channel = `investigation:${investigationId}`;
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }
}

export const investigationEventBus = InvestigationEventBus.getInstance();
