import { buildSchemaPrompt, fetchClickHouseSchema } from '../schema';

// Mock the clickhouse connection module
jest.mock('@/controllers/connection', () => ({
  getConnectionById: jest.fn().mockResolvedValue({
    host: 'http://localhost:8123',
    username: 'default',
    password: '',
  }),
}));

describe('ClickHouse schema introspection', () => {
  it('buildSchemaPrompt formats schema for AI system prompt', () => {
    const schema = [
      {
        table: 'otel_traces',
        columns: [
          { name: 'TraceId', type: 'String' },
          { name: 'SpanId', type: 'String' },
          { name: 'ServiceName', type: 'LowCardinality(String)' },
          { name: 'Duration', type: 'Int64' },
        ],
      },
      {
        table: 'otel_logs',
        columns: [
          { name: 'Timestamp', type: 'DateTime64(9)' },
          { name: 'Body', type: 'String' },
          { name: 'SeverityText', type: 'LowCardinality(String)' },
        ],
      },
    ];

    const prompt = buildSchemaPrompt(schema);
    expect(prompt).toContain('otel_traces');
    expect(prompt).toContain('TraceId (String)');
    expect(prompt).toContain('otel_logs');
    expect(prompt).toContain('Body (String)');
  });
});
