import { buildSchemaPrompt, fetchClickHouseSchema } from '../schema';

// Mock the clickhouse connection module
jest.mock('@/controllers/connection', () => ({
  getConnectionById: jest.fn().mockResolvedValue({
    host: 'http://localhost:8123',
    username: 'default',
    password: '',
  }),
}));

// Mock ClickhouseClient to avoid URL validation on fake connection strings
jest.mock('@hyperdx/common-utils/dist/clickhouse/node', () => ({
  ClickhouseClient: jest.fn().mockImplementation(() => ({
    query: jest.fn().mockResolvedValue({
      text: jest.fn().mockResolvedValue('[]'),
    }),
  })),
}));

import { createInvestigationTools } from '../tools';

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

const FAKE_OPTS = {
  connection: { host: 'localhost', username: 'u', password: 'p' },
  teamId: 'team1',
  userId: 'user1',
};

describe('createInvestigationTools — phase scoping', () => {
  it('plan phase: only orientation tools', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'plan' });
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining([
        'retrieveMemory',
        'getActiveAlerts',
        'getServiceHealthScore',
        'getServiceMap',
      ]),
    );
    expect(names).not.toContain('searchTraces');
    expect(names).not.toContain('createAlert');
  });

  it('execute phase: diagnostic tools only', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'execute' });
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining([
        'searchTraces',
        'searchLogs',
        'getMetrics',
        'findSimilarErrors',
        'getBaselineMetrics',
        'getServiceMap',
      ]),
    );
    expect(names).not.toContain('createAlert');
    expect(names).not.toContain('retrieveMemory');
  });

  it('verify phase: cross-check subset', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'verify' });
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining([
        'searchTraces',
        'searchLogs',
        'getMetrics',
        'findSimilarErrors',
      ]),
    );
    expect(names).not.toContain('createAlert');
    expect(names).not.toContain('getBaselineMetrics');
  });

  it('summarize phase: artifact tools only', () => {
    const tools = createInvestigationTools({
      ...FAKE_OPTS,
      phase: 'summarize',
    });
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining([
        'createSavedSearch',
        'createDashboard',
        'createAlert',
      ]),
    );
    expect(names).not.toContain('searchTraces');
  });

  it('no phase (legacy): all tools returned', () => {
    const tools = createInvestigationTools(FAKE_OPTS);
    expect(Object.keys(tools).length).toBeGreaterThan(10);
  });
});
