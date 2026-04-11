import { investigationEventBus } from '../investigationEventBus';

describe('InvestigationEventBus', () => {
  it('emits phase_start events to subscribers', done => {
    const investigationId = 'test-inv-123';
    const unsubscribe = investigationEventBus.subscribeToInvestigation(
      investigationId,
      event => {
        expect(event.type).toBe('phase_start');
        expect(event.investigationId).toBe(investigationId);
        if (event.type === 'phase_start') {
          expect(event.phase).toBe('plan');
        }
        unsubscribe();
        done();
      },
    );

    investigationEventBus.emitDebugEvent({
      type: 'phase_start',
      investigationId,
      phase: 'plan',
      timestamp: Date.now(),
    });
  });

  it('emits phase_end events with summaryText', done => {
    const investigationId = 'test-inv-456';
    const unsubscribe = investigationEventBus.subscribeToInvestigation(
      investigationId,
      event => {
        expect(event.type).toBe('phase_end');
        if (event.type === 'phase_end') {
          expect(event.summaryText).toBe('test summary');
          expect(event.toolCallCount).toBe(3);
        }
        unsubscribe();
        done();
      },
    );

    investigationEventBus.emitDebugEvent({
      type: 'phase_end',
      investigationId,
      phase: 'execute',
      summaryText: 'test summary',
      toolCallCount: 3,
      timestamp: Date.now(),
    });
  });

  it('does not deliver events to other investigation subscribers', done => {
    const investigationId1 = 'test-inv-001';
    const investigationId2 = 'test-inv-002';
    let receivedCount = 0;

    const unsubscribe = investigationEventBus.subscribeToInvestigation(
      investigationId2,
      () => {
        receivedCount++;
      },
    );

    investigationEventBus.emitDebugEvent({
      type: 'phase_start',
      investigationId: investigationId1,
      phase: 'plan',
      timestamp: Date.now(),
    });

    // Give a tick for any async delivery
    setTimeout(() => {
      expect(receivedCount).toBe(0);
      unsubscribe();
      done();
    }, 10);
  });

  it('cleanup function removes subscriber', done => {
    const investigationId = 'test-inv-789';
    let receivedCount = 0;

    const unsubscribe = investigationEventBus.subscribeToInvestigation(
      investigationId,
      () => {
        receivedCount++;
      },
    );

    // Unsubscribe immediately
    unsubscribe();

    investigationEventBus.emitDebugEvent({
      type: 'investigation_complete',
      investigationId,
      confidence: 'high',
      timestamp: Date.now(),
    });

    setTimeout(() => {
      expect(receivedCount).toBe(0);
      done();
    }, 10);
  });
});
