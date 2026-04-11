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
  | 'investigation_failed';

export interface PhaseStartEvent {
  type: 'phase_start';
  investigationId: string;
  phase: string;
  timestamp: number;
}

export interface PhaseEndEvent {
  type: 'phase_end';
  investigationId: string;
  phase: string;
  summaryText: string;
  toolCallCount: number;
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

export type DebugEvent =
  | PhaseStartEvent
  | PhaseEndEvent
  | InvestigationCompleteEvent
  | InvestigationFailedEvent;

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
