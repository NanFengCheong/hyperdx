import { buildSystemPrompt, convertMessagesToAIFormat } from '../investigation-agent';
import type { IInvestigationMessage } from '@/models/investigation';

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
