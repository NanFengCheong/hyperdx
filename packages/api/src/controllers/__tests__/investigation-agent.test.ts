import type { IInvestigationMessage } from '@/models/investigation';

import {
  buildSystemPrompt,
  convertMessagesToAIFormat,
  buildPlanSystemPrompt,
  buildExecuteSystemPrompt,
  buildVerifySystemPrompt,
  buildSummarizeSystemPrompt,
} from '../investigation-agent';

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
const EVIDENCE = 'EVIDENCE: searchLogs → 847 DB timeout errors → supports Hypothesis 1';
const VERDICTS = 'VERDICT: CONFIRMED — DB connection pool exhausted';

describe('buildPlanSystemPrompt', () => {
  it('declares PLANNING role', () => {
    const p = buildPlanSystemPrompt({ schemaPrompt: SCHEMA, triggerDescription: TRIGGER, memoryContext: MEMORY });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/PLANNING/);
  });
  it('includes abort condition for NO_ANOMALY', () => {
    const p = buildPlanSystemPrompt({ schemaPrompt: SCHEMA, triggerDescription: TRIGGER, memoryContext: MEMORY });
    expect(p).toMatch(/NO_ANOMALY/);
  });
  it('specifies structured JSON output format', () => {
    const p = buildPlanSystemPrompt({ schemaPrompt: SCHEMA, triggerDescription: TRIGGER, memoryContext: MEMORY });
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
    const p = buildVerifySystemPrompt({ evidenceLog: EVIDENCE, schemaPrompt: SCHEMA });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/VERIFICATION/);
  });
  it('instructs independent angles (no repeated queries)', () => {
    const p = buildVerifySystemPrompt({ evidenceLog: EVIDENCE, schemaPrompt: SCHEMA });
    expect(p).toMatch(/Do not repeat/i);
  });
  it('specifies VERDICT output format with three states', () => {
    const p = buildVerifySystemPrompt({ evidenceLog: EVIDENCE, schemaPrompt: SCHEMA });
    expect(p).toMatch(/CONFIRMED/);
    expect(p).toMatch(/WEAKENED/);
    expect(p).toMatch(/INCONCLUSIVE/);
  });
});

describe('buildSummarizeSystemPrompt', () => {
  it('declares SUMMARIZATION role', () => {
    const p = buildSummarizeSystemPrompt({ plan: PLAN, evidenceLog: EVIDENCE, verificationVerdicts: VERDICTS, schemaPrompt: SCHEMA });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/SUMMARIZATION/);
  });
  it('gates artifact creation on confidence', () => {
    const p = buildSummarizeSystemPrompt({ plan: PLAN, evidenceLog: EVIDENCE, verificationVerdicts: VERDICTS, schemaPrompt: SCHEMA });
    expect(p).toMatch(/confidence.*medium.*high|medium.*high.*confidence/i);
  });
  it('instructs low-confidence disclaimer when WEAKENED present', () => {
    const p = buildSummarizeSystemPrompt({ plan: PLAN, evidenceLog: EVIDENCE, verificationVerdicts: VERDICTS, schemaPrompt: SCHEMA });
    expect(p).toMatch(/WEAKENED/);
    expect(p).toMatch(/not confident/i);
  });
});
