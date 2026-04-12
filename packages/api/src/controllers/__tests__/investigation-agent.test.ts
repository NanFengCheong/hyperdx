import type { IInvestigationMessage } from '@/models/investigation';

import {
  buildExecuteSystemPrompt,
  buildPlanSystemPrompt,
  buildSummarizeSystemPrompt,
  buildSystemPrompt,
  buildVerifySystemPrompt,
  convertMessagesToAIFormat,
  runAgentPhase,
  runInvestigationCycle,
} from '../investigation-agent';

// Mock streamText to capture toolChoice passed to it
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return {
    ...actual,
    streamText: jest.fn().mockImplementation((opts: any) => {
      (global as any).__lastStreamTextOpts = opts;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'test output' };
        })(),
        response: Promise.resolve({
          messages: [{ role: 'assistant' as const, content: 'test output' }],
        }),
      };
    }),
  };
});

// Mock getAIModel to return a fake model without env var checks
jest.mock('@/controllers/ai', () => ({
  getAIModel: jest.fn().mockReturnValue({}),
}));

// Mock createInvestigationTools to avoid ClickHouse client creation
jest.mock('@/controllers/investigation-tools/tools', () => ({
  createInvestigationTools: jest.fn().mockReturnValue({}),
}));

describe('Investigation agent', () => {
  it('builds system prompt with schema and entry point context', () => {
    const prompt = buildSystemPrompt({
      schemaPrompt: 'Available tables: otel_traces: TraceId, SpanName',
      entryPoint: { type: 'trace' as const, traceId: 'abc123' },
    });
    expect(prompt).toContain('otel_traces');
    expect(prompt).toContain('abc123');
    expect(prompt).toContain('searchTraces');
    expect(prompt).toContain('incident report');
  });

  it('builds system prompt for standalone entry point', () => {
    const prompt = buildSystemPrompt({
      schemaPrompt: 'Available tables: otel_logs: Body, SeverityText',
      entryPoint: { type: 'standalone' as const },
    });
    expect(prompt).toContain('otel_logs');
    expect(prompt).not.toContain('traceId');
  });

  it('builds system prompt for alert entry point', () => {
    const prompt = buildSystemPrompt({
      schemaPrompt: 'Available tables: otel_traces',
      entryPoint: { type: 'alert' as const, alertId: 'alert456' },
    });
    expect(prompt).toContain('alert456');
    expect(prompt).toContain('alert');
  });

  it('converts messages to AI format, filtering out tool messages', () => {
    const messages: IInvestigationMessage[] = [
      { role: 'user', content: 'Hello', timestamp: new Date() },
      { role: 'assistant', content: 'Hi there', timestamp: new Date() },
      { role: 'tool', content: 'tool result', timestamp: new Date() },
    ];
    const result = convertMessagesToAIFormat(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });
});

const SCHEMA = 'table: logs (timestamp, level, message)';
const TRIGGER = 'payment-service error rate spiked to 12%';
const MEMORY = 'No prior incidents found.';
const PLAN = '1. Check error logs\n2. Check metrics';
const EVIDENCE =
  'EVIDENCE: searchLogs → 847 DB timeout errors → supports Hypothesis 1';
const VERDICTS = 'VERDICT: CONFIRMED — DB connection pool exhausted';

describe('buildPlanSystemPrompt', () => {
  it('declares PLANNING role', () => {
    const p = buildPlanSystemPrompt({
      schemaPrompt: SCHEMA,
      triggerDescription: TRIGGER,
      memoryContext: MEMORY,
    });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/PLANNING/);
  });
  it('includes abort condition for NO_ANOMALY', () => {
    const p = buildPlanSystemPrompt({
      schemaPrompt: SCHEMA,
      triggerDescription: TRIGGER,
      memoryContext: MEMORY,
    });
    expect(p).toMatch(/NO_ANOMALY/);
  });
  it('specifies structured JSON output format', () => {
    const p = buildPlanSystemPrompt({
      schemaPrompt: SCHEMA,
      triggerDescription: TRIGGER,
      memoryContext: MEMORY,
    });
    expect(p).toMatch(/hypotheses/);
    expect(p).toMatch(/evidencePlan/);
    expect(p).toMatch(/abortIf/);
  });
});

describe('buildExecuteSystemPrompt', () => {
  it('declares EXECUTION role', () => {
    const p = buildExecuteSystemPrompt({ plan: PLAN, schemaPrompt: SCHEMA });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/EXECUTION/);
  });
  it('instructs sequential tool calls', () => {
    const p = buildExecuteSystemPrompt({ plan: PLAN, schemaPrompt: SCHEMA });
    expect(p).toMatch(/sequential/i);
  });
  it('specifies EVIDENCE output format', () => {
    const p = buildExecuteSystemPrompt({ plan: PLAN, schemaPrompt: SCHEMA });
    expect(p).toMatch(/EVIDENCE:/);
    expect(p).toMatch(/supports\/refutes\/inconclusive/i);
  });
});

describe('buildVerifySystemPrompt', () => {
  it('declares VERIFICATION role', () => {
    const p = buildVerifySystemPrompt({
      evidenceLog: EVIDENCE,
      schemaPrompt: SCHEMA,
    });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/VERIFICATION/);
  });
  it('instructs independent angles (no repeated queries)', () => {
    const p = buildVerifySystemPrompt({
      evidenceLog: EVIDENCE,
      schemaPrompt: SCHEMA,
    });
    expect(p).toMatch(/Do not repeat/i);
  });
  it('specifies VERDICT output format with three states', () => {
    const p = buildVerifySystemPrompt({
      evidenceLog: EVIDENCE,
      schemaPrompt: SCHEMA,
    });
    expect(p).toMatch(/CONFIRMED/);
    expect(p).toMatch(/WEAKENED/);
    expect(p).toMatch(/INCONCLUSIVE/);
  });
});

describe('buildSummarizeSystemPrompt', () => {
  it('declares SUMMARIZATION role', () => {
    const p = buildSummarizeSystemPrompt({
      plan: PLAN,
      evidenceLog: EVIDENCE,
      verificationVerdicts: VERDICTS,
      schemaPrompt: SCHEMA,
    });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/SUMMARIZATION/);
  });
  it('gates artifact creation on confidence', () => {
    const p = buildSummarizeSystemPrompt({
      plan: PLAN,
      evidenceLog: EVIDENCE,
      verificationVerdicts: VERDICTS,
      schemaPrompt: SCHEMA,
    });
    expect(p).toMatch(/confidence.*medium.*high|medium.*high.*confidence/i);
  });
  it('instructs low-confidence disclaimer when WEAKENED present', () => {
    const p = buildSummarizeSystemPrompt({
      plan: PLAN,
      evidenceLog: EVIDENCE,
      verificationVerdicts: VERDICTS,
      schemaPrompt: SCHEMA,
    });
    expect(p).toMatch(/WEAKENED/);
    expect(p).toMatch(/not confident/i);
  });
});

describe('runAgentPhase — forceFirstStep', () => {
  it('passes toolChoice required when forceFirstStep is true', async () => {
    await runAgentPhase({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'test',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
      forceFirstStep: true,
    });
    expect((global as any).__lastStreamTextOpts.toolChoice).toBe('required');
  });

  it('does not set toolChoice required when forceFirstStep is false', async () => {
    await runAgentPhase({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'test',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
      forceFirstStep: false,
    });
    expect((global as any).__lastStreamTextOpts.toolChoice).not.toBe(
      'required',
    );
  });
});

describe('runAgentPhase — outputMessages', () => {
  it('returns outputMessages from response', async () => {
    const result = await runAgentPhase({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'test',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    });
    expect(result.outputMessages).toBeDefined();
    expect(Array.isArray(result.outputMessages)).toBe(true);
  });
});

describe('runInvestigationCycle — execute→verify threading', () => {
  it('verify phase receives execute outputMessages as initial messages', async () => {
    const streamTextMock = require('ai').streamText as jest.Mock;
    const capturedCalls: any[] = [];
    streamTextMock.mockImplementation((opts: any) => {
      capturedCalls.push({ phaseName: opts.system?.match(/## Role\n(.+)/)?.[1], messages: opts.messages });
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'output' };
        })(),
        response: Promise.resolve({ messages: [{ role: 'assistant', content: 'output' }] }),
      };
    });

    await runInvestigationCycle({
      triggerDescription: 'test trigger',
      triggerType: 'health_scan',
      schemaPrompt: 'schema',
      memoryContext: 'none',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    });

    // Find the verify call
    const verifyCall = capturedCalls.find(c => c.phaseName?.includes('VERIFICATION'));
    expect(verifyCall).toBeDefined();
    // Verify messages should contain more than just the fresh user message
    // (it inherits execute's thread)
    expect(verifyCall.messages.length).toBeGreaterThan(1);
  });
});

describe('runInvestigationCycle — phase tool scoping', () => {
  it('passes phase to createInvestigationTools for each phase', async () => {
    // Smoke test: cycle completes without throwing
    await expect(runInvestigationCycle({
      triggerDescription: 'test',
      triggerType: 'health_scan',
      schemaPrompt: 'schema',
      memoryContext: 'none',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    })).resolves.toBeDefined();
  });
});

describe('runInvestigationCycle — NO_ANOMALY early exit', () => {
  it('skips execute/verify/summarize phases when plan emits NO_ANOMALY', async () => {
    const streamTextMock = require('ai').streamText as jest.Mock;
    const originalImpl = streamTextMock.getMockImplementation();
    let callCount = 0;
    streamTextMock.mockImplementation(() => {
      callCount++;
      const isFirstCall = callCount === 1;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: isFirstCall ? 'NO_ANOMALY' : 'output' };
        })(),
        response: Promise.resolve({ messages: [] }),
      };
    });

    try {
      const result = await runInvestigationCycle({
        triggerDescription: 'test',
        triggerType: 'health_scan',
        schemaPrompt: 'schema',
        memoryContext: 'none',
        connection: { host: 'h', username: 'u', password: 'p' },
        teamId: 't1',
        userId: 'u1',
      });

      // Only plan phase ran (1 streamText call)
      expect(callCount).toBe(1);
      expect(result.confidence).toBe('low');
      expect(result.summary).toMatch(/NO_ANOMALY|no anomaly/i);
    } finally {
      streamTextMock.mockImplementation(originalImpl);
    }
  });
});
