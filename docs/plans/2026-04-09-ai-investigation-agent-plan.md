# AI Investigation Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-turn AI investigation agent that helps users debug traces, find root causes, and generate incident reports using tool-calling against ClickHouse/MongoDB.

**Architecture:** Server-side agent using Vercel `ai` SDK's `streamText` with tool definitions. Express SSE endpoint streams responses. MongoDB stores persistent investigation conversations. Frontend uses a shared chat component rendered in both a side panel (from trace/alert views) and a full page (`/investigations`).

**Tech Stack:** TypeScript, Express, Mongoose, Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`), ClickHouse (HTTP), React, Next.js, Mantine UI, TanStack Query

**Design doc:** `docs/plans/2026-04-09-ai-investigation-agent-design.md`

---

## Task 1: Investigation Mongoose Model

**Files:**
- Create: `packages/api/src/models/investigation.ts`
- Test: `packages/api/src/models/__tests__/investigation.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/api/src/models/__tests__/investigation.test.ts
import mongoose from 'mongoose';

import Investigation from '../investigation';

describe('Investigation model', () => {
  beforeAll(async () => {
    await mongoose.connect(
      process.env.MONGO_URI || 'mongodb://localhost:27017/hyperdx-test',
    );
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  it('should create an investigation with required fields', async () => {
    const teamId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const investigation = await Investigation.create({
      team: teamId,
      createdBy: userId,
      title: 'Test investigation',
      status: 'active',
      entryPoint: { type: 'standalone' },
      messages: [],
    });

    expect(investigation._id).toBeDefined();
    expect(investigation.team.toString()).toBe(teamId.toString());
    expect(investigation.status).toBe('active');
    expect(investigation.messages).toHaveLength(0);
  });

  it('should store messages with tool calls', async () => {
    const teamId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const investigation = await Investigation.create({
      team: teamId,
      createdBy: userId,
      title: 'Trace investigation',
      status: 'active',
      entryPoint: { type: 'trace', traceId: 'abc123' },
      messages: [
        {
          role: 'user',
          content: 'Why did this trace fail?',
          timestamp: new Date(),
        },
        {
          role: 'assistant',
          content: 'The trace failed due to a timeout.',
          toolCalls: [
            {
              name: 'getTraceDetail',
              args: { traceId: 'abc123' },
              result: { spans: [] },
            },
          ],
          timestamp: new Date(),
        },
      ],
    });

    expect(investigation.messages).toHaveLength(2);
    expect(investigation.messages[1].toolCalls).toHaveLength(1);
    expect(investigation.messages[1].toolCalls![0].name).toBe(
      'getTraceDetail',
    );
  });

  it('should store exports', async () => {
    const teamId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();

    const investigation = await Investigation.create({
      team: teamId,
      createdBy: userId,
      title: 'Exported investigation',
      status: 'exported',
      entryPoint: { type: 'standalone' },
      messages: [],
      exports: [
        {
          format: 'markdown',
          content: '# Incident Report\n\nSummary here.',
          createdAt: new Date(),
        },
      ],
    });

    expect(investigation.exports).toHaveLength(1);
    expect(investigation.exports![0].format).toBe('markdown');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/api && yarn ci:unit src/models/__tests__/investigation.test.ts`
Expected: FAIL — `Cannot find module '../investigation'`

**Step 3: Write the model**

```typescript
// packages/api/src/models/investigation.ts
import mongoose, { Schema } from 'mongoose';

import type { ObjectId } from '.';

export type InvestigationStatus = 'active' | 'resolved' | 'exported';

export type EntryPointType = 'trace' | 'alert' | 'standalone';

export interface IToolCall {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface IInvestigationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: IToolCall[];
  timestamp: Date;
}

export interface IInvestigationExport {
  format: 'markdown' | 'json';
  content: string;
  createdAt: Date;
}

export interface IInvestigation {
  _id: ObjectId;
  team: ObjectId;
  createdBy: ObjectId;
  title: string;
  status: InvestigationStatus;
  entryPoint: {
    type: EntryPointType;
    traceId?: string;
    alertId?: ObjectId;
  };
  messages: IInvestigationMessage[];
  summary?: string;
  sharedWith?: ObjectId[];
  exports?: IInvestigationExport[];
  createdAt: Date;
  updatedAt: Date;
}

const ToolCallSchema = new Schema(
  {
    name: { type: String, required: true },
    args: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const MessageSchema = new Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant', 'tool'],
      required: true,
    },
    content: { type: String, required: true },
    toolCalls: { type: [ToolCallSchema], default: undefined },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ExportSchema = new Schema(
  {
    format: { type: String, enum: ['markdown', 'json'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const InvestigationSchema = new Schema<IInvestigation>(
  {
    team: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    status: {
      type: String,
      enum: ['active', 'resolved', 'exported'],
      default: 'active',
    },
    entryPoint: {
      type: {
        type: String,
        enum: ['trace', 'alert', 'standalone'],
        required: true,
      },
      traceId: { type: String },
      alertId: { type: Schema.Types.ObjectId },
    },
    messages: { type: [MessageSchema], default: [] },
    summary: { type: String },
    sharedWith: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    exports: { type: [ExportSchema], default: undefined },
  },
  { timestamps: true },
);

// Index for team-scoped queries
InvestigationSchema.index({ team: 1, createdAt: -1 });
InvestigationSchema.index({ team: 1, status: 1 });
InvestigationSchema.index({ sharedWith: 1 });

const Investigation = mongoose.model<IInvestigation>(
  'Investigation',
  InvestigationSchema,
);

export default Investigation;
```

**Step 4: Run test to verify it passes**

Run: `cd packages/api && yarn ci:unit src/models/__tests__/investigation.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/models/investigation.ts packages/api/src/models/__tests__/investigation.test.ts
git commit -m "feat(investigation): add Investigation mongoose model"
```

---

## Task 2: Investigation Controller — CRUD Operations

**Files:**
- Create: `packages/api/src/controllers/investigation.ts`
- Test: `packages/api/src/controllers/__tests__/investigation.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/api/src/controllers/__tests__/investigation.test.ts
import mongoose from 'mongoose';

import {
  createInvestigation,
  deleteInvestigation,
  getInvestigation,
  listInvestigations,
  updateInvestigation,
} from '../investigation';

describe('Investigation controller', () => {
  let teamId: mongoose.Types.ObjectId;
  let userId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    await mongoose.connect(
      process.env.MONGO_URI || 'mongodb://localhost:27017/hyperdx-test',
    );
    teamId = new mongoose.Types.ObjectId();
    userId = new mongoose.Types.ObjectId();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
  });

  it('should create an investigation', async () => {
    const result = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Test',
      entryPoint: { type: 'standalone' as const },
    });
    expect(result._id).toBeDefined();
    expect(result.status).toBe('active');
  });

  it('should list investigations for a team', async () => {
    const results = await listInvestigations({
      teamId: teamId.toString(),
      page: 1,
      limit: 10,
    });
    expect(results.data.length).toBeGreaterThan(0);
    expect(results.total).toBeGreaterThan(0);
  });

  it('should get a single investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Get test',
      entryPoint: { type: 'trace' as const, traceId: 'xyz' },
    });
    const result = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Get test');
  });

  it('should update an investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Update test',
      entryPoint: { type: 'standalone' as const },
    });
    const updated = await updateInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
      updates: { title: 'Updated title', status: 'resolved' },
    });
    expect(updated!.title).toBe('Updated title');
    expect(updated!.status).toBe('resolved');
  });

  it('should soft-delete an investigation', async () => {
    const created = await createInvestigation({
      teamId: teamId.toString(),
      userId: userId.toString(),
      title: 'Delete test',
      entryPoint: { type: 'standalone' as const },
    });
    await deleteInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
    });
    const result = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: created._id.toString(),
    });
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/api && yarn ci:unit src/controllers/__tests__/investigation.test.ts`
Expected: FAIL — `Cannot find module '../investigation'`

**Step 3: Write the controller**

```typescript
// packages/api/src/controllers/investigation.ts
import Investigation from '@/models/investigation';
import type {
  EntryPointType,
  InvestigationStatus,
} from '@/models/investigation';

export async function createInvestigation({
  teamId,
  userId,
  title,
  entryPoint,
}: {
  teamId: string;
  userId: string;
  title: string;
  entryPoint: { type: EntryPointType; traceId?: string; alertId?: string };
}) {
  return Investigation.create({
    team: teamId,
    createdBy: userId,
    title,
    status: 'active',
    entryPoint,
    messages: [],
  });
}

export async function listInvestigations({
  teamId,
  page = 1,
  limit = 20,
}: {
  teamId: string;
  page?: number;
  limit?: number;
}) {
  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    Investigation.find({ team: teamId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-messages') // Exclude messages from list view
      .lean(),
    Investigation.countDocuments({ team: teamId }),
  ]);
  return { data, total, page, limit };
}

export async function getInvestigation({
  teamId,
  investigationId,
}: {
  teamId: string;
  investigationId: string;
}) {
  return Investigation.findOne({
    _id: investigationId,
    team: teamId,
  }).lean();
}

export async function updateInvestigation({
  teamId,
  investigationId,
  updates,
}: {
  teamId: string;
  investigationId: string;
  updates: Partial<{
    title: string;
    status: InvestigationStatus;
    sharedWith: string[];
    summary: string;
  }>;
}) {
  return Investigation.findOneAndUpdate(
    { _id: investigationId, team: teamId },
    { $set: updates },
    { new: true },
  ).lean();
}

export async function deleteInvestigation({
  teamId,
  investigationId,
}: {
  teamId: string;
  investigationId: string;
}) {
  return Investigation.findOneAndDelete({
    _id: investigationId,
    team: teamId,
  });
}

export async function appendMessage({
  teamId,
  investigationId,
  message,
}: {
  teamId: string;
  investigationId: string;
  message: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: { name: string; args: unknown; result: unknown }[];
  };
}) {
  return Investigation.findOneAndUpdate(
    { _id: investigationId, team: teamId },
    {
      $push: {
        messages: { ...message, timestamp: new Date() },
      },
    },
    { new: true },
  ).lean();
}

export async function addExport({
  teamId,
  investigationId,
  exportData,
}: {
  teamId: string;
  investigationId: string;
  exportData: { format: 'markdown' | 'json'; content: string };
}) {
  return Investigation.findOneAndUpdate(
    { _id: investigationId, team: teamId },
    {
      $push: {
        exports: { ...exportData, createdAt: new Date() },
      },
      $set: { status: 'exported' },
    },
    { new: true },
  ).lean();
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/api && yarn ci:unit src/controllers/__tests__/investigation.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/controllers/investigation.ts packages/api/src/controllers/__tests__/investigation.test.ts
git commit -m "feat(investigation): add investigation CRUD controller"
```

---

## Task 3: ClickHouse Schema Introspection

**Files:**
- Create: `packages/api/src/controllers/investigation-tools/schema.ts`
- Test: `packages/api/src/controllers/investigation-tools/__tests__/schema.test.ts`

**Step 1: Write failing test**

```typescript
// packages/api/src/controllers/investigation-tools/__tests__/schema.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `cd packages/api && yarn ci:unit src/controllers/investigation-tools/__tests__/schema.test.ts`
Expected: FAIL

**Step 3: Write the schema module**

```typescript
// packages/api/src/controllers/investigation-tools/schema.ts
import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';

import { getConnectionById } from '@/controllers/connection';

export interface TableSchema {
  table: string;
  columns: { name: string; type: string }[];
}

export async function fetchClickHouseSchema(
  teamId: string,
  connectionId: string,
): Promise<TableSchema[]> {
  const connection = await getConnectionById(teamId, connectionId, true);
  if (!connection) {
    throw new Error('Invalid connection');
  }

  const client = new ClickhouseClient({
    host: connection.host,
    username: connection.username,
    password: connection.password,
  });

  // Get all tables
  const tablesResult = await client.query<'JSONEachRow'>({
    query: 'SHOW TABLES',
    format: 'JSONEachRow',
  });

  const tables: TableSchema[] = [];

  for (const row of tablesResult) {
    const tableName = (row as Record<string, string>).name;
    // Skip system/internal tables
    if (tableName.startsWith('.') || tableName.startsWith('system')) {
      continue;
    }

    const columnsResult = await client.query<'JSONEachRow'>({
      query: `DESCRIBE TABLE ${tableName}`,
      format: 'JSONEachRow',
    });

    tables.push({
      table: tableName,
      columns: (columnsResult as Record<string, string>[]).map((col) => ({
        name: col.name,
        type: col.type,
      })),
    });
  }

  return tables;
}

export function buildSchemaPrompt(schema: TableSchema[]): string {
  const lines = ['Available ClickHouse tables and columns:'];

  for (const table of schema) {
    const cols = table.columns.map((c) => `${c.name} (${c.type})`).join(', ');
    lines.push(`- ${table.table}: ${cols}`);
  }

  return lines.join('\n');
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/api && yarn ci:unit src/controllers/investigation-tools/__tests__/schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/controllers/investigation-tools/
git commit -m "feat(investigation): add ClickHouse schema introspection"
```

---

## Task 4: AI Investigation Tools — searchTraces, getTraceDetail, searchLogs

**Files:**
- Create: `packages/api/src/controllers/investigation-tools/tools.ts`
- Test: `packages/api/src/controllers/investigation-tools/__tests__/tools.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/api/src/controllers/investigation-tools/__tests__/tools.test.ts
import { z } from 'zod';

import {
  getTraceDetailTool,
  searchLogsTool,
  searchTracesTool,
} from '../tools';

describe('Investigation tool definitions', () => {
  it('searchTraces has correct schema', () => {
    expect(searchTracesTool.name).toBe('searchTraces');
    expect(searchTracesTool.description).toContain('trace');
    // Validate schema shape
    const params = searchTracesTool.parameters as z.ZodObject<any>;
    expect(params.shape.timeRange).toBeDefined();
  });

  it('getTraceDetail has correct schema', () => {
    expect(getTraceDetailTool.name).toBe('getTraceDetail');
    const params = getTraceDetailTool.parameters as z.ZodObject<any>;
    expect(params.shape.traceId).toBeDefined();
  });

  it('searchLogs has correct schema', () => {
    expect(searchLogsTool.name).toBe('searchLogs');
    const params = searchLogsTool.parameters as z.ZodObject<any>;
    expect(params.shape.query).toBeDefined();
    expect(params.shape.timeRange).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/api && yarn ci:unit src/controllers/investigation-tools/__tests__/tools.test.ts`
Expected: FAIL

**Step 3: Write the tools module**

This module defines all 7 tools as Vercel AI SDK-compatible tool objects. Each tool has a `name`, `description`, `parameters` (Zod schema), and `execute` function.

```typescript
// packages/api/src/controllers/investigation-tools/tools.ts
import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import { tool } from 'ai';
import { z } from 'zod';

import logger from '@/utils/logger';

// Shared time range schema
const timeRangeSchema = z.object({
  start: z.string().describe('ISO 8601 start time'),
  end: z.string().describe('ISO 8601 end time'),
});

// Helper to create a ClickHouse client from connection info
function createClient(connection: {
  host: string;
  username: string;
  password: string;
}) {
  return new ClickhouseClient({
    host: connection.host,
    username: connection.username,
    password: connection.password,
  });
}

// Helper to format results for AI consumption (truncate large results)
function formatForAI(rows: unknown[], maxRows = 20): string {
  const truncated = rows.slice(0, maxRows);
  const result = JSON.stringify(truncated, null, 2);
  if (rows.length > maxRows) {
    return `${result}\n... (${rows.length - maxRows} more rows truncated)`;
  }
  return result;
}

export function createInvestigationTools(connection: {
  host: string;
  username: string;
  password: string;
}) {
  const client = createClient(connection);

  const searchTraces = tool({
    description:
      'Search for traces by service name, time range, status, or duration. Returns top matching traces.',
    parameters: z.object({
      timeRange: timeRangeSchema,
      service: z.string().optional().describe('Filter by service name'),
      status: z
        .enum(['OK', 'ERROR', 'UNSET'])
        .optional()
        .describe('Filter by span status'),
      minDuration: z
        .number()
        .optional()
        .describe('Minimum duration in milliseconds'),
      query: z
        .string()
        .optional()
        .describe('Additional WHERE clause conditions'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Additional columns to select'),
    }),
    execute: async (params) => {
      const conditions = [
        `Timestamp >= '${params.timeRange.start}'`,
        `Timestamp <= '${params.timeRange.end}'`,
      ];
      if (params.service) {
        conditions.push(`ServiceName = {service:String}`);
      }
      if (params.status) {
        conditions.push(`StatusCode = {status:String}`);
      }
      if (params.minDuration) {
        conditions.push(`Duration >= {minDuration:UInt64}`);
      }
      if (params.query) {
        conditions.push(params.query);
      }

      const extraFields = params.fields?.length
        ? `, ${params.fields.join(', ')}`
        : '';

      const query = `
        SELECT TraceId, SpanName, ServiceName, Duration, StatusCode, Timestamp${extraFields}
        FROM otel_traces
        WHERE ${conditions.join(' AND ')}
        ORDER BY Timestamp DESC
        LIMIT 20
      `;

      try {
        const rows = await client.query<'JSONEachRow'>({
          query,
          query_params: {
            service: params.service ?? '',
            status: params.status ?? '',
            minDuration: params.minDuration ?? 0,
          },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[]);
      } catch (err) {
        logger.error({ err, query }, 'searchTraces failed');
        return `Error searching traces: ${(err as Error).message}`;
      }
    },
  });

  const getTraceDetail = tool({
    description:
      'Get the full span tree for a specific trace ID, including timing, attributes, events, and errors.',
    parameters: z.object({
      traceId: z.string().describe('The trace ID to look up'),
    }),
    execute: async (params) => {
      const query = `
        SELECT TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
               Duration, StatusCode, StatusMessage,
               SpanAttributes, ResourceAttributes, Events
        FROM otel_traces
        WHERE TraceId = {traceId:String}
        ORDER BY Timestamp ASC
      `;

      try {
        const rows = await client.query<'JSONEachRow'>({
          query,
          query_params: { traceId: params.traceId },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[], 50);
      } catch (err) {
        logger.error({ err }, 'getTraceDetail failed');
        return `Error getting trace detail: ${(err as Error).message}`;
      }
    },
  });

  const searchLogs = tool({
    description:
      'Search logs by text query, time range, service, and severity level.',
    parameters: z.object({
      query: z.string().describe('Text to search for in log body'),
      timeRange: timeRangeSchema,
      service: z.string().optional().describe('Filter by service name'),
      level: z
        .string()
        .optional()
        .describe('Severity level (e.g. error, warn, info)'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Additional columns to select'),
    }),
    execute: async (params) => {
      const conditions = [
        `Timestamp >= '${params.timeRange.start}'`,
        `Timestamp <= '${params.timeRange.end}'`,
        `Body ILIKE {query:String}`,
      ];
      if (params.service) {
        conditions.push(`ServiceName = {service:String}`);
      }
      if (params.level) {
        conditions.push(`SeverityText = {level:String}`);
      }

      const extraFields = params.fields?.length
        ? `, ${params.fields.join(', ')}`
        : '';

      const query = `
        SELECT Timestamp, ServiceName, SeverityText, Body${extraFields}
        FROM otel_logs
        WHERE ${conditions.join(' AND ')}
        ORDER BY Timestamp DESC
        LIMIT 50
      `;

      try {
        const rows = await client.query<'JSONEachRow'>({
          query,
          query_params: {
            query: `%${params.query}%`,
            service: params.service ?? '',
            level: params.level ?? '',
          },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[], 50);
      } catch (err) {
        logger.error({ err }, 'searchLogs failed');
        return `Error searching logs: ${(err as Error).message}`;
      }
    },
  });

  const getMetrics = tool({
    description:
      'Get time series metrics (error rate, latency percentiles, throughput) for a service.',
    parameters: z.object({
      service: z.string().describe('Service name'),
      metric: z
        .enum(['error_rate', 'latency', 'throughput'])
        .describe('Metric type'),
      timeRange: timeRangeSchema,
      granularity: z
        .enum(['1m', '5m', '15m', '1h'])
        .optional()
        .describe('Time bucket granularity'),
    }),
    execute: async (params) => {
      const granularity = params.granularity ?? '5m';
      const granularitySeconds =
        {
          '1m': 60,
          '5m': 300,
          '15m': 900,
          '1h': 3600,
        }[granularity] ?? 300;

      let query: string;

      switch (params.metric) {
        case 'error_rate':
          query = `
            SELECT
              toStartOfInterval(Timestamp, INTERVAL ${granularitySeconds} SECOND) AS bucket,
              countIf(StatusCode = 'ERROR') AS errors,
              count() AS total,
              round(errors / total * 100, 2) AS error_rate_pct
            FROM otel_traces
            WHERE ServiceName = {service:String}
              AND Timestamp >= '${params.timeRange.start}'
              AND Timestamp <= '${params.timeRange.end}'
            GROUP BY bucket
            ORDER BY bucket
          `;
          break;
        case 'latency':
          query = `
            SELECT
              toStartOfInterval(Timestamp, INTERVAL ${granularitySeconds} SECOND) AS bucket,
              quantile(0.5)(Duration) AS p50,
              quantile(0.95)(Duration) AS p95,
              quantile(0.99)(Duration) AS p99
            FROM otel_traces
            WHERE ServiceName = {service:String}
              AND Timestamp >= '${params.timeRange.start}'
              AND Timestamp <= '${params.timeRange.end}'
            GROUP BY bucket
            ORDER BY bucket
          `;
          break;
        case 'throughput':
          query = `
            SELECT
              toStartOfInterval(Timestamp, INTERVAL ${granularitySeconds} SECOND) AS bucket,
              count() AS request_count
            FROM otel_traces
            WHERE ServiceName = {service:String}
              AND Timestamp >= '${params.timeRange.start}'
              AND Timestamp <= '${params.timeRange.end}'
            GROUP BY bucket
            ORDER BY bucket
          `;
          break;
      }

      try {
        const rows = await client.query<'JSONEachRow'>({
          query,
          query_params: { service: params.service },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[], 100);
      } catch (err) {
        logger.error({ err }, 'getMetrics failed');
        return `Error getting metrics: ${(err as Error).message}`;
      }
    },
  });

  const findSimilarErrors = tool({
    description:
      'Find traces and logs with similar error messages, grouped by pattern with frequency counts.',
    parameters: z.object({
      errorMessage: z.string().describe('Error message pattern to search for'),
      service: z.string().optional().describe('Filter by service name'),
      timeRange: timeRangeSchema.optional().describe('Time range to search'),
    }),
    execute: async (params) => {
      const timeFilter = params.timeRange
        ? `AND Timestamp >= '${params.timeRange.start}' AND Timestamp <= '${params.timeRange.end}'`
        : "AND Timestamp >= now() - INTERVAL 24 HOUR";
      const serviceFilter = params.service
        ? `AND ServiceName = {service:String}`
        : '';

      const query = `
        SELECT
          StatusMessage,
          ServiceName,
          count() AS occurrences,
          min(Timestamp) AS first_seen,
          max(Timestamp) AS last_seen,
          groupArray(5)(TraceId) AS sample_trace_ids
        FROM otel_traces
        WHERE StatusCode = 'ERROR'
          AND StatusMessage ILIKE {errorPattern:String}
          ${timeFilter}
          ${serviceFilter}
        GROUP BY StatusMessage, ServiceName
        ORDER BY occurrences DESC
        LIMIT 20
      `;

      try {
        const rows = await client.query<'JSONEachRow'>({
          query,
          query_params: {
            errorPattern: `%${params.errorMessage}%`,
            service: params.service ?? '',
          },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[]);
      } catch (err) {
        logger.error({ err }, 'findSimilarErrors failed');
        return `Error finding similar errors: ${(err as Error).message}`;
      }
    },
  });

  const getServiceMap = tool({
    description:
      'Get upstream and downstream service dependencies with edge latency and error rates.',
    parameters: z.object({
      service: z
        .string()
        .optional()
        .describe('Center service (omit for full map)'),
      timeRange: timeRangeSchema,
    }),
    execute: async (params) => {
      const serviceFilter = params.service
        ? `AND (parent.ServiceName = {service:String} OR child.ServiceName = {service:String})`
        : '';

      const query = `
        SELECT
          parent.ServiceName AS source,
          child.ServiceName AS target,
          count() AS call_count,
          avg(child.Duration) AS avg_duration,
          countIf(child.StatusCode = 'ERROR') AS error_count,
          round(error_count / call_count * 100, 2) AS error_rate_pct
        FROM otel_traces AS child
        INNER JOIN otel_traces AS parent
          ON child.ParentSpanId = parent.SpanId
          AND child.TraceId = parent.TraceId
        WHERE child.Timestamp >= '${params.timeRange.start}'
          AND child.Timestamp <= '${params.timeRange.end}'
          AND parent.ServiceName != child.ServiceName
          ${serviceFilter}
        GROUP BY source, target
        ORDER BY call_count DESC
        LIMIT 50
      `;

      try {
        const rows = await client.query<'JSONEachRow'>({
          query,
          query_params: { service: params.service ?? '' },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[], 50);
      } catch (err) {
        logger.error({ err }, 'getServiceMap failed');
        return `Error getting service map: ${(err as Error).message}`;
      }
    },
  });

  const getSessionReplay = tool({
    description:
      'Get session replay metadata and linked trace IDs for a given trace or session ID.',
    parameters: z.object({
      traceId: z.string().optional().describe('Find session linked to this trace'),
      sessionId: z.string().optional().describe('Direct session ID lookup'),
    }),
    execute: async (params) => {
      if (!params.traceId && !params.sessionId) {
        return 'Error: provide either traceId or sessionId';
      }

      try {
        let sessionQuery: string;
        if (params.sessionId) {
          sessionQuery = `
            SELECT SessionId, MIN(Timestamp) AS start, MAX(Timestamp) AS end,
                   count() AS event_count,
                   groupUniqArray(TraceId) AS linked_traces
            FROM hyperdx_sessions
            WHERE SessionId = {id:String}
            GROUP BY SessionId
          `;
        } else {
          // Find session by traceId — look in traces for session attribute, then query sessions
          sessionQuery = `
            SELECT SessionId, MIN(Timestamp) AS start, MAX(Timestamp) AS end,
                   count() AS event_count,
                   groupUniqArray(TraceId) AS linked_traces
            FROM hyperdx_sessions
            WHERE SessionId IN (
              SELECT DISTINCT ResourceAttributes['session.id']
              FROM otel_traces
              WHERE TraceId = {id:String}
            )
            GROUP BY SessionId
          `;
        }

        const rows = await client.query<'JSONEachRow'>({
          query: sessionQuery,
          query_params: { id: params.sessionId ?? params.traceId ?? '' },
          format: 'JSONEachRow',
        });
        return formatForAI(rows as unknown[]);
      } catch (err) {
        logger.error({ err }, 'getSessionReplay failed');
        return `Error getting session replay: ${(err as Error).message}`;
      }
    },
  });

  return {
    searchTraces,
    getTraceDetail,
    searchLogs,
    getMetrics,
    findSimilarErrors,
    getServiceMap,
    getSessionReplay,
  };
}

// Re-export individual tool references for testing
export const searchTracesTool = {
  name: 'searchTraces',
  description: 'Search for traces by service name, time range, status, or duration.',
  parameters: z.object({
    timeRange: z.object({
      start: z.string(),
      end: z.string(),
    }),
    service: z.string().optional(),
    status: z.enum(['OK', 'ERROR', 'UNSET']).optional(),
    minDuration: z.number().optional(),
    query: z.string().optional(),
    fields: z.array(z.string()).optional(),
  }),
};

export const getTraceDetailTool = {
  name: 'getTraceDetail',
  description: 'Get full span tree for a trace ID.',
  parameters: z.object({
    traceId: z.string(),
  }),
};

export const searchLogsTool = {
  name: 'searchLogs',
  description: 'Search logs by text query and filters.',
  parameters: z.object({
    query: z.string(),
    timeRange: z.object({ start: z.string(), end: z.string() }),
    service: z.string().optional(),
    level: z.string().optional(),
    fields: z.array(z.string()).optional(),
  }),
};
```

**Step 4: Run test to verify it passes**

Run: `cd packages/api && yarn ci:unit src/controllers/investigation-tools/__tests__/tools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/controllers/investigation-tools/
git commit -m "feat(investigation): add 7 AI investigation tools for ClickHouse queries"
```

---

## Task 5: AI Agent Loop — streamText with Tools

**Files:**
- Create: `packages/api/src/controllers/investigation-agent.ts`
- Test: `packages/api/src/controllers/__tests__/investigation-agent.test.ts`

**Step 1: Write failing test**

```typescript
// packages/api/src/controllers/__tests__/investigation-agent.test.ts
import { buildSystemPrompt } from '../investigation-agent';

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
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts`
Expected: FAIL

**Step 3: Write the agent module**

```typescript
// packages/api/src/controllers/investigation-agent.ts
import { streamText } from 'ai';
import type { LanguageModel } from 'ai';

import { getAIModel } from '@/controllers/ai';
import type { IInvestigationMessage } from '@/models/investigation';

import { createInvestigationTools } from './investigation-tools/tools';

interface EntryPoint {
  type: 'trace' | 'alert' | 'standalone';
  traceId?: string;
  alertId?: string;
}

export function buildSystemPrompt({
  schemaPrompt,
  entryPoint,
}: {
  schemaPrompt: string;
  entryPoint: EntryPoint;
}) {
  const entryContext =
    entryPoint.type === 'trace'
      ? `\n\nThe user is investigating trace ID: ${entryPoint.traceId}. Start by fetching this trace's details.`
      : entryPoint.type === 'alert'
        ? `\n\nThis investigation was triggered by an alert (ID: ${entryPoint.alertId}). Start by examining the alert's context.`
        : '';

  return `You are an AI investigation agent for HyperDX, an observability platform. Your role is to help engineers debug production incidents by analyzing traces, logs, metrics, and session replays.

## Available Tools

You have 7 tools to query observability data:
- **searchTraces**: Find traces by service, time range, status, or duration
- **getTraceDetail**: Get the full span tree for a specific trace
- **searchLogs**: Search log entries by text, service, and severity
- **getMetrics**: Get time series metrics (error rate, latency, throughput)
- **findSimilarErrors**: Find historically similar error patterns
- **getServiceMap**: Get service dependency graph with error rates
- **getSessionReplay**: Get session replay data linked to a trace

## Database Schema

${schemaPrompt}

## Guidelines

1. **Use tools proactively** — don't just explain what you *could* do, actually query the data.
2. **Cite evidence** — always reference specific trace IDs, log entries, or metrics when making conclusions.
3. **Think step by step** — explain your reasoning as you investigate.
4. **Correlate across signals** — connect traces to logs to metrics to build a complete picture.
5. **When asked for an incident report**, synthesize all findings into a structured report with: Summary, Timeline, Root Cause, Affected Services, Evidence, and Recommendations.
6. **Time ranges** — if the user doesn't specify, default to the last 30 minutes around the investigation's anchor point.${entryContext}`;
}

export function convertMessagesToAIFormat(
  messages: IInvestigationMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}

export async function runInvestigationAgent({
  messages,
  systemPrompt,
  connection,
  onTextDelta,
  onToolCall,
  onFinish,
}: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: string;
  connection: { host: string; username: string; password: string };
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: unknown, result: unknown) => void;
  onFinish?: (text: string) => void;
}) {
  const model = getAIModel();
  const tools = createInvestigationTools(connection);

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    maxSteps: 10, // Allow up to 10 tool call rounds
    experimental_telemetry: { isEnabled: true },
  });

  let fullText = '';

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        fullText += part.textDelta;
        onTextDelta?.(part.textDelta);
        break;
      case 'tool-result':
        onToolCall?.(part.toolName, part.args, part.result);
        break;
    }
  }

  onFinish?.(fullText);

  return { text: fullText, toolCalls: (await result.toolCalls) ?? [] };
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/api/src/controllers/investigation-agent.ts packages/api/src/controllers/__tests__/investigation-agent.test.ts
git commit -m "feat(investigation): add AI agent loop with streamText and tool definitions"
```

---

## Task 6: Investigation API Router

**Files:**
- Create: `packages/api/src/routers/api/investigations.ts`
- Modify: `packages/api/src/routers/api/index.ts` — add `investigationsRouter` export
- Modify: `packages/api/src/api-app.ts` — register `/investigations` route

**Step 1: Write the router**

```typescript
// packages/api/src/routers/api/investigations.ts
import express from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import { getAIModel } from '@/controllers/ai';
import {
  addExport,
  appendMessage,
  createInvestigation,
  deleteInvestigation,
  getInvestigation,
  listInvestigations,
  updateInvestigation,
} from '@/controllers/investigation';
import {
  buildSystemPrompt,
  convertMessagesToAIFormat,
  runInvestigationAgent,
} from '@/controllers/investigation-agent';
import {
  buildSchemaPrompt,
  fetchClickHouseSchema,
} from '@/controllers/investigation-tools/schema';
import { getNonNullUserWithTeam } from '@/middleware/auth';
import { getConnectionById } from '@/controllers/connection';
import { getSource } from '@/controllers/sources';
import logger from '@/utils/logger';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

// POST /investigations — Create a new investigation
router.post(
  '/',
  validateRequest({
    body: z.object({
      title: z.string().min(1).max(200),
      entryPoint: z.object({
        type: z.enum(['trace', 'alert', 'standalone']),
        traceId: z.string().optional(),
        alertId: z.string().optional(),
      }),
      sourceId: objectIdSchema.optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId, id: userId } = getNonNullUserWithTeam(req);
      const { title, entryPoint, sourceId } = req.body;

      const investigation = await createInvestigation({
        teamId: teamId.toString(),
        userId: userId.toString(),
        title,
        entryPoint,
      });

      res.json(investigation);
    } catch (e) {
      next(e);
    }
  },
);

// GET /investigations — List investigations
router.get(
  '/',
  validateRequest({
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const { page, limit } = req.query;

      const results = await listInvestigations({
        teamId: teamId.toString(),
        page,
        limit,
      });

      res.json(results);
    } catch (e) {
      next(e);
    }
  },
);

// GET /investigations/:id — Get a single investigation
router.get('/:id', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);
    const investigation = await getInvestigation({
      teamId: teamId.toString(),
      investigationId: req.params.id,
    });

    if (!investigation) {
      return res.status(404).json({ error: 'Investigation not found' });
    }

    res.json(investigation);
  } catch (e) {
    next(e);
  }
});

// POST /investigations/:id/messages — Send message & run agent loop (SSE)
router.post(
  '/:id/messages',
  validateRequest({
    body: z.object({
      content: z.string().min(1).max(10000),
      sourceId: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const { content, sourceId } = req.body;
      const investigationId = req.params.id;

      // Verify investigation exists
      const investigation = await getInvestigation({
        teamId: teamId.toString(),
        investigationId,
      });
      if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      // Get ClickHouse connection
      const source = await getSource(teamId.toString(), sourceId);
      if (!source) {
        return res.status(404).json({ error: 'Source not found' });
      }
      const connection = await getConnectionById(
        teamId.toString(),
        source.connection.toString(),
        true,
      );
      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      // Append user message
      await appendMessage({
        teamId: teamId.toString(),
        investigationId,
        message: { role: 'user', content },
      });

      // Fetch schema for system prompt
      const schema = await fetchClickHouseSchema(
        teamId.toString(),
        source.connection.toString(),
      );
      const schemaPrompt = buildSchemaPrompt(schema);
      const systemPrompt = buildSystemPrompt({
        schemaPrompt,
        entryPoint: investigation.entryPoint,
      });

      // Convert messages to AI format
      const allMessages = [
        ...convertMessagesToAIFormat(investigation.messages),
        { role: 'user' as const, content },
      ];

      // Set up SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const toolCalls: { name: string; args: unknown; result: unknown }[] = [];

      // Run agent
      const { text } = await runInvestigationAgent({
        messages: allMessages,
        systemPrompt,
        connection: {
          host: connection.host,
          username: connection.username,
          password: connection.password,
        },
        onTextDelta: (delta) => {
          res.write(`data: ${JSON.stringify({ type: 'text', content: delta })}\n\n`);
        },
        onToolCall: (toolName, args, result) => {
          toolCalls.push({ name: toolName, args, result });
          res.write(
            `data: ${JSON.stringify({ type: 'tool', name: toolName, args, result })}\n\n`,
          );
        },
        onFinish: () => {
          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
        },
      });

      // Persist assistant message
      await appendMessage({
        teamId: teamId.toString(),
        investigationId,
        message: {
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      });
    } catch (e) {
      // If SSE already started, send error event
      if (res.headersSent) {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: (e as Error).message })}\n\n`,
        );
        res.end();
      } else {
        next(e);
      }
    }
  },
);

// PATCH /investigations/:id — Update investigation
router.patch(
  '/:id',
  validateRequest({
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      status: z.enum(['active', 'resolved', 'exported']).optional(),
      sharedWith: z.array(z.string()).optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const updated = await updateInvestigation({
        teamId: teamId.toString(),
        investigationId: req.params.id,
        updates: req.body,
      });

      if (!updated) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

// DELETE /investigations/:id — Soft delete
router.delete('/:id', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);
    await deleteInvestigation({
      teamId: teamId.toString(),
      investigationId: req.params.id,
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /investigations/:id/export — Generate incident report
router.post(
  '/:id/export',
  validateRequest({
    body: z.object({
      format: z.enum(['markdown', 'json']).default('markdown'),
      sourceId: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const { format, sourceId } = req.body;
      const investigationId = req.params.id;

      const investigation = await getInvestigation({
        teamId: teamId.toString(),
        investigationId,
      });
      if (!investigation) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      if (format === 'json') {
        const result = await addExport({
          teamId: teamId.toString(),
          investigationId,
          exportData: {
            format: 'json',
            content: JSON.stringify(investigation, null, 2),
          },
        });
        return res.json(result);
      }

      // For markdown: ask AI to synthesize a report
      const source = await getSource(teamId.toString(), sourceId);
      if (!source) {
        return res.status(404).json({ error: 'Source not found' });
      }
      const connection = await getConnectionById(
        teamId.toString(),
        source.connection.toString(),
        true,
      );
      if (!connection) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      const allMessages = convertMessagesToAIFormat(investigation.messages);
      allMessages.push({
        role: 'user',
        content:
          'Please synthesize all findings from this investigation into a structured incident report in markdown format. Include sections: ## Summary, ## Timeline, ## Root Cause, ## Affected Services, ## Evidence, ## Recommendations.',
      });

      const { text } = await runInvestigationAgent({
        messages: allMessages,
        systemPrompt:
          'You are an incident report generator. Synthesize the investigation findings into a clear, structured incident report.',
        connection: {
          host: connection.host,
          username: connection.username,
          password: connection.password,
        },
      });

      const result = await addExport({
        teamId: teamId.toString(),
        investigationId,
        exportData: { format: 'markdown', content: text },
      });

      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// POST /investigations/:id/share — Share with team members
router.post(
  '/:id/share',
  validateRequest({
    body: z.object({
      userIds: z.array(z.string()).min(1),
    }),
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const updated = await updateInvestigation({
        teamId: teamId.toString(),
        investigationId: req.params.id,
        updates: { sharedWith: req.body.userIds },
      });

      if (!updated) {
        return res.status(404).json({ error: 'Investigation not found' });
      }

      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

export default router;
```

**Step 2: Register the router**

In `packages/api/src/routers/api/index.ts`, add:
```typescript
import investigationsRouter from './investigations';
// ... in the export:
investigationsRouter,
```

In `packages/api/src/api-app.ts`, add after the existing router registrations:
```typescript
import investigationsRouter from './routers/api/investigations';
// ...
app.use('/investigations', isUserAuthenticated, requireWriteAccess, investigationsRouter);
```

**Step 3: Run lint to verify**

Run: `cd packages/api && npx tsc --noEmit`
Expected: No type errors

**Step 4: Commit**

```bash
git add packages/api/src/routers/api/investigations.ts packages/api/src/routers/api/index.ts packages/api/src/api-app.ts
git commit -m "feat(investigation): add investigation API router with SSE streaming"
```

---

## Task 7: Frontend — Investigation API Hooks

**Files:**
- Create: `packages/app/src/hooks/useInvestigations.ts`

**Step 1: Write the hooks**

```typescript
// packages/app/src/hooks/useInvestigations.ts
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { API_SERVER_URL } from '../config';

interface Investigation {
  _id: string;
  team: string;
  createdBy: string;
  title: string;
  status: 'active' | 'resolved' | 'exported';
  entryPoint: {
    type: 'trace' | 'alert' | 'standalone';
    traceId?: string;
    alertId?: string;
  };
  messages: InvestigationMessage[];
  summary?: string;
  sharedWith?: string[];
  exports?: { format: string; content: string; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
}

interface InvestigationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { name: string; args: unknown; result: unknown }[];
  timestamp: string;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_SERVER_URL}${url}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

export function useInvestigations(page = 1, limit = 20) {
  return useQuery({
    queryKey: ['investigations', page, limit],
    queryFn: () =>
      fetchJson<{ data: Investigation[]; total: number }>(
        `/investigations?page=${page}&limit=${limit}`,
      ),
  });
}

export function useInvestigation(id: string | undefined) {
  return useQuery({
    queryKey: ['investigation', id],
    queryFn: () => fetchJson<Investigation>(`/investigations/${id}`),
    enabled: !!id,
  });
}

export function useCreateInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      entryPoint: Investigation['entryPoint'];
      sourceId?: string;
    }) =>
      fetchJson<Investigation>('/investigations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}

export function useUpdateInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...updates
    }: {
      id: string;
      title?: string;
      status?: string;
      sharedWith?: string[];
    }) =>
      fetchJson<Investigation>(`/investigations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['investigation', data._id] });
      queryClient.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}

export function useDeleteInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/investigations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}

export function useExportInvestigation() {
  return useMutation({
    mutationFn: ({
      id,
      format,
      sourceId,
    }: {
      id: string;
      format: 'markdown' | 'json';
      sourceId: string;
    }) =>
      fetchJson<Investigation>(`/investigations/${id}/export`, {
        method: 'POST',
        body: JSON.stringify({ format, sourceId }),
      }),
  });
}

// SSE streaming hook for sending messages
export function useInvestigationChat(investigationId: string | undefined) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [toolEvents, setToolEvents] = useState<
    { name: string; args: unknown; result: unknown }[]
  >([]);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const sendMessage = useCallback(
    async (content: string, sourceId: string) => {
      if (!investigationId || isStreaming) return;

      setIsStreaming(true);
      setStreamedText('');
      setToolEvents([]);

      abortRef.current = new AbortController();

      try {
        const res = await fetch(
          `${API_SERVER_URL}/investigations/${investigationId}/messages`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, sourceId }),
            signal: abortRef.current.signal,
          },
        );

        if (!res.ok) {
          throw new Error(`API error: ${res.status}`);
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) throw new Error('No response body');

        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = JSON.parse(line.slice(6));

            switch (data.type) {
              case 'text':
                setStreamedText((prev) => prev + data.content);
                break;
              case 'tool':
                setToolEvents((prev) => [
                  ...prev,
                  { name: data.name, args: data.args, result: data.result },
                ]);
                break;
              case 'done':
                break;
              case 'error':
                throw new Error(data.message);
            }
          }
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        // Refresh investigation to get persisted messages
        queryClient.invalidateQueries({
          queryKey: ['investigation', investigationId],
        });
      }
    },
    [investigationId, isStreaming, queryClient],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    sendMessage,
    cancel,
    isStreaming,
    streamedText,
    toolEvents,
  };
}
```

**Step 2: Commit**

```bash
git add packages/app/src/hooks/useInvestigations.ts
git commit -m "feat(investigation): add React hooks for investigation API and SSE chat"
```

---

## Task 8: Frontend — InvestigationChat Component

**Files:**
- Create: `packages/app/src/components/Investigation/InvestigationChat.tsx`
- Create: `packages/app/src/components/Investigation/InvestigationMessage.tsx`
- Create: `packages/app/src/components/Investigation/index.ts`

**Step 1: Write InvestigationMessage**

```typescript
// packages/app/src/components/Investigation/InvestigationMessage.tsx
import {
  Badge,
  Box,
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { memo } from 'react';

import { Markdown } from '../Markdown';

interface ToolCall {
  name: string;
  args: unknown;
  result: unknown;
}

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: string;
}

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const [opened, { toggle }] = useDisclosure(false);

  return (
    <Paper
      p="xs"
      withBorder
      style={{ cursor: 'pointer' }}
      onClick={toggle}
    >
      <Group gap="xs">
        <Badge size="xs" variant="outline">
          Tool
        </Badge>
        <Text size="xs" fw={500}>
          {toolCall.name}
        </Text>
      </Group>
      <Collapse in={opened}>
        <Box mt="xs">
          <Text size="xs" c="dimmed">
            Args: {JSON.stringify(toolCall.args, null, 2)}
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            Result: {String(toolCall.result).slice(0, 500)}
            {String(toolCall.result).length > 500 ? '...' : ''}
          </Text>
        </Box>
      </Collapse>
    </Paper>
  );
}

function InvestigationMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <Box
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
      }}
    >
      <Paper
        p="sm"
        radius="md"
        bg={isUser ? 'blue.9' : 'dark.6'}
      >
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Stack gap="xs" mb="xs">
            {message.toolCalls.map((tc, i) => (
              <ToolCallDisplay key={i} toolCall={tc} />
            ))}
          </Stack>
        )}
        {isUser ? (
          <Text size="sm">{message.content}</Text>
        ) : (
          <Markdown>{message.content}</Markdown>
        )}
      </Paper>
      <Text size="xs" c="dimmed" mt={2}>
        {new Date(message.timestamp).toLocaleTimeString()}
      </Text>
    </Box>
  );
}

export default memo(InvestigationMessage);
```

**Step 2: Write InvestigationChat**

```typescript
// packages/app/src/components/Investigation/InvestigationChat.tsx
import {
  ActionIcon,
  Box,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  useInvestigation,
  useInvestigationChat,
} from '../../hooks/useInvestigations';
import { Markdown } from '../Markdown';

import InvestigationMessage from './InvestigationMessage';

interface InvestigationChatProps {
  investigationId: string;
  sourceId: string;
}

export default function InvestigationChat({
  investigationId,
  sourceId,
}: InvestigationChatProps) {
  const { data: investigation } = useInvestigation(investigationId);
  const { sendMessage, isStreaming, streamedText, toolEvents, cancel } =
    useInvestigationChat(investigationId);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    viewportRef.current?.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [investigation?.messages, streamedText]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim(), sourceId);
    setInput('');
  }, [input, isStreaming, sendMessage, sourceId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Stack h="100%" gap={0}>
      {/* Messages area */}
      <ScrollArea
        style={{ flex: 1 }}
        viewportRef={viewportRef}
        ref={scrollRef}
      >
        <Stack gap="md" p="md">
          {investigation?.messages.map((msg, i) => (
            <InvestigationMessage key={i} message={msg} />
          ))}

          {/* Streaming response */}
          {isStreaming && (
            <Box style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
              {toolEvents.map((te, i) => (
                <Text key={i} size="xs" c="dimmed" mb="xs">
                  🔧 {te.name}({JSON.stringify(te.args).slice(0, 100)})
                </Text>
              ))}
              {streamedText ? (
                <Markdown>{streamedText}</Markdown>
              ) : (
                <Loader size="sm" />
              )}
            </Box>
          )}
        </Stack>
      </ScrollArea>

      {/* Input area */}
      <Box p="md" style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}>
        <Box style={{ display: 'flex', gap: 8 }}>
          <Textarea
            style={{ flex: 1 }}
            placeholder="Ask about this trace, search logs, find root cause..."
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            autosize
            minRows={1}
            maxRows={4}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <ActionIcon
              variant="secondary"
              onClick={cancel}
              size="lg"
              mt="auto"
            >
              ⏹
            </ActionIcon>
          ) : (
            <ActionIcon
              variant="primary"
              onClick={handleSend}
              size="lg"
              mt="auto"
              disabled={!input.trim()}
            >
              →
            </ActionIcon>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
```

**Step 3: Write barrel export**

```typescript
// packages/app/src/components/Investigation/index.ts
export { default as InvestigationChat } from './InvestigationChat';
export { default as InvestigationMessage } from './InvestigationMessage';
```

**Step 4: Commit**

```bash
git add packages/app/src/components/Investigation/
git commit -m "feat(investigation): add InvestigationChat and InvestigationMessage components"
```

---

## Task 9: Frontend — Investigation Side Panel

**Files:**
- Create: `packages/app/src/components/Investigation/InvestigationSidePanel.tsx`
- Modify: `packages/app/src/components/DBTracePanel.tsx` — add "Investigate" button

**Step 1: Write the side panel**

```typescript
// packages/app/src/components/Investigation/InvestigationSidePanel.tsx
import { Drawer, Group, Text, ActionIcon, Box } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';

import { useCreateInvestigation } from '../../hooks/useInvestigations';

import InvestigationChat from './InvestigationChat';

interface InvestigationSidePanelProps {
  opened: boolean;
  onClose: () => void;
  traceId?: string;
  alertId?: string;
  sourceId: string;
}

export default function InvestigationSidePanel({
  opened,
  onClose,
  traceId,
  alertId,
  sourceId,
}: InvestigationSidePanelProps) {
  const router = useRouter();
  const createInvestigation = useCreateInvestigation();
  const [investigationId, setInvestigationId] = useState<string | null>(null);

  useHotkeys([['Escape', onClose]]);

  // Create investigation on first open if none exists
  const handleOpen = useCallback(async () => {
    if (investigationId) return;

    const entryPoint = traceId
      ? { type: 'trace' as const, traceId }
      : alertId
        ? { type: 'alert' as const, alertId }
        : { type: 'standalone' as const };

    const result = await createInvestigation.mutateAsync({
      title: traceId
        ? `Investigate trace ${traceId.slice(0, 8)}...`
        : alertId
          ? `Alert investigation`
          : 'New investigation',
      entryPoint,
      sourceId,
    });

    setInvestigationId(result._id);
  }, [investigationId, traceId, alertId, sourceId, createInvestigation]);

  // Create investigation when panel opens
  if (opened && !investigationId && !createInvestigation.isPending) {
    handleOpen();
  }

  const handleExpand = useCallback(() => {
    if (investigationId) {
      router.push(`/investigations/${investigationId}`);
    }
  }, [investigationId, router]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={
        <Group gap="sm">
          <Text fw={600}>AI Investigation</Text>
          <ActionIcon variant="subtle" size="sm" onClick={handleExpand}>
            ↗
          </ActionIcon>
        </Group>
      }
      styles={{
        body: { height: 'calc(100vh - 60px)', padding: 0 },
      }}
    >
      {investigationId ? (
        <InvestigationChat
          investigationId={investigationId}
          sourceId={sourceId}
        />
      ) : (
        <Box p="md">
          <Text c="dimmed">Creating investigation...</Text>
        </Box>
      )}
    </Drawer>
  );
}
```

**Step 2: Add "Investigate" button to DBTracePanel**

In `packages/app/src/components/DBTracePanel.tsx`, add an "Investigate" button that opens the side panel. This requires:
- Import `InvestigationSidePanel`
- Add state: `const [investigationOpened, setInvestigationOpened] = useState(false)`
- Add button in the trace panel header area
- Render the `InvestigationSidePanel` component

**Step 3: Commit**

```bash
git add packages/app/src/components/Investigation/InvestigationSidePanel.tsx packages/app/src/components/DBTracePanel.tsx
git commit -m "feat(investigation): add side panel with 'Investigate' button on trace view"
```

---

## Task 10: Frontend — Investigations Full Page

**Files:**
- Create: `packages/app/pages/investigations/index.tsx`
- Create: `packages/app/pages/investigations/[id].tsx`

**Step 1: Write the list page**

```typescript
// packages/app/pages/investigations/index.tsx
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

import AppNav from '../../src/components/AppNav';
import {
  useCreateInvestigation,
  useInvestigations,
} from '../../src/hooks/useInvestigations';

const STATUS_COLORS: Record<string, string> = {
  active: 'blue',
  resolved: 'green',
  exported: 'violet',
};

export default function InvestigationsPage() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useInvestigations(page);
  const createInvestigation = useCreateInvestigation();

  const handleNew = async () => {
    const result = await createInvestigation.mutateAsync({
      title: 'New investigation',
      entryPoint: { type: 'standalone' },
    });
    router.push(`/investigations/${result._id}`);
  };

  return (
    <Box>
      <Head>
        <title>Investigations | HyperDX</title>
      </Head>
      <AppNav />
      <Box p="lg">
        <Group justify="space-between" mb="lg">
          <Title order={3}>Investigations</Title>
          <Button
            variant="primary"
            onClick={handleNew}
            loading={createInvestigation.isPending}
          >
            New Investigation
          </Button>
        </Group>

        {isLoading ? (
          <Text c="dimmed">Loading...</Text>
        ) : (
          <Paper withBorder>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Title</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Entry Point</Table.Th>
                  <Table.Th>Created</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {data?.data.map((inv) => (
                  <Table.Tr
                    key={inv._id}
                    style={{ cursor: 'pointer' }}
                    onClick={() =>
                      router.push(`/investigations/${inv._id}`)
                    }
                  >
                    <Table.Td>
                      <Text fw={500}>{inv.title}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={STATUS_COLORS[inv.status] ?? 'gray'}>
                        {inv.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="outline" size="sm">
                        {inv.entryPoint.type}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(inv.createdAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Paper>
        )}

        {data && data.total > 20 && (
          <Group justify="center" mt="md">
            <Button
              variant="subtle"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Text size="sm">
              Page {page} of {Math.ceil(data.total / 20)}
            </Text>
            <Button
              variant="subtle"
              disabled={page * 20 >= data.total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </Group>
        )}
      </Box>
    </Box>
  );
}
```

**Step 2: Write the detail page**

```typescript
// packages/app/pages/investigations/[id].tsx
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import Head from 'next/head';
import { useRouter } from 'next/router';

import AppNav from '../../src/components/AppNav';
import { InvestigationChat } from '../../src/components/Investigation';
import {
  useDeleteInvestigation,
  useExportInvestigation,
  useInvestigation,
  useUpdateInvestigation,
} from '../../src/hooks/useInvestigations';

export default function InvestigationDetailPage() {
  const router = useRouter();
  const id = router.query.id as string;
  const { data: investigation, isLoading } = useInvestigation(id);
  const updateInvestigation = useUpdateInvestigation();
  const deleteInvestigation = useDeleteInvestigation();
  const exportInvestigation = useExportInvestigation();

  if (isLoading || !investigation) {
    return (
      <Box>
        <AppNav />
        <Box p="lg">
          <Text c="dimmed">Loading...</Text>
        </Box>
      </Box>
    );
  }

  // TODO: sourceId should come from investigation metadata or user selection
  const sourceId = '';

  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      <Head>
        <title>{investigation.title} | HyperDX</title>
      </Head>
      <AppNav />

      {/* Header */}
      <Box
        p="md"
        style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
      >
        <Group justify="space-between">
          <Group gap="sm">
            <Title order={4}>{investigation.title}</Title>
            <Badge>{investigation.status}</Badge>
            <Badge variant="outline" size="sm">
              {investigation.entryPoint.type}
            </Badge>
          </Group>
          <Group gap="xs">
            <Menu>
              <Menu.Target>
                <Button variant="secondary" size="sm">
                  Actions
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() =>
                    updateInvestigation.mutate({
                      id: investigation._id,
                      status: 'resolved',
                    })
                  }
                >
                  Mark Resolved
                </Menu.Item>
                <Menu.Item
                  onClick={() =>
                    exportInvestigation.mutate({
                      id: investigation._id,
                      format: 'markdown',
                      sourceId,
                    })
                  }
                >
                  Export as Markdown
                </Menu.Item>
                <Menu.Item
                  onClick={() =>
                    exportInvestigation.mutate({
                      id: investigation._id,
                      format: 'json',
                      sourceId,
                    })
                  }
                >
                  Export as JSON
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  onClick={async () => {
                    await deleteInvestigation.mutateAsync(investigation._id);
                    router.push('/investigations');
                  }}
                >
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </Box>

      {/* Chat area */}
      <Box style={{ flex: 1, overflow: 'hidden' }}>
        <InvestigationChat investigationId={id} sourceId={sourceId} />
      </Box>
    </Box>
  );
}
```

**Step 3: Commit**

```bash
git add packages/app/pages/investigations/
git commit -m "feat(investigation): add investigations list and detail pages"
```

---

## Task 11: Alert Integration — Semi-Auto Investigation

**Files:**
- Modify: `packages/api/src/controllers/investigation.ts` — add `createAlertInvestigation`
- Modify: `packages/app/pages/alerts.tsx` — add "Investigate" button on alert rows

**Step 1: Add createAlertInvestigation to controller**

```typescript
// Add to packages/api/src/controllers/investigation.ts

import Alert from '@/models/alert';

export async function createAlertInvestigation({
  teamId,
  userId,
  alertId,
  sourceId,
  connectionInfo,
}: {
  teamId: string;
  userId: string;
  alertId: string;
  sourceId: string;
  connectionInfo: { host: string; username: string; password: string };
}) {
  const alert = await Alert.findOne({ _id: alertId, team: teamId });
  if (!alert) throw new Error('Alert not found');

  // Create investigation
  const investigation = await Investigation.create({
    team: teamId,
    createdBy: userId,
    title: `Alert: ${alert.name || 'Unnamed alert'}`,
    status: 'active',
    entryPoint: { type: 'alert', alertId },
    messages: [
      {
        role: 'user',
        content: `Investigate this alert: "${alert.name || 'Alert'}". It triggered at ${new Date().toISOString()} with threshold ${alert.threshold} (${alert.thresholdType}). Interval: ${alert.interval}. Please fetch relevant traces, logs, and metrics to identify the root cause.`,
        timestamp: new Date(),
      },
    ],
  });

  return investigation;
}
```

**Step 2: Add "Investigate" button on alerts page**

In `packages/app/pages/alerts.tsx`, add an "Investigate" action button for each alert that creates a new alert investigation and navigates to it.

**Step 3: Commit**

```bash
git add packages/api/src/controllers/investigation.ts packages/app/pages/alerts.tsx
git commit -m "feat(investigation): add semi-auto alert investigation entry point"
```

---

## Task 12: Export & Share UI

**Files:**
- Create: `packages/app/src/components/Investigation/InvestigationExport.tsx`
- Modify: `packages/app/pages/investigations/[id].tsx` — wire up export modal

**Step 1: Write the export component**

```typescript
// packages/app/src/components/Investigation/InvestigationExport.tsx
import {
  Box,
  Button,
  CopyButton,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useState } from 'react';

interface InvestigationExportProps {
  opened: boolean;
  onClose: () => void;
  exports: { format: string; content: string; createdAt: string }[];
  onExport: (format: 'markdown' | 'json') => void;
  isExporting: boolean;
}

export default function InvestigationExport({
  opened,
  onClose,
  exports: exportsList,
  onExport,
  isExporting,
}: InvestigationExportProps) {
  const [selectedFormat, setSelectedFormat] = useState<'markdown' | 'json'>(
    'markdown',
  );
  const latestExport = exportsList?.[exportsList.length - 1];

  return (
    <Modal opened={opened} onClose={onClose} title="Export Investigation" size="lg">
      <Stack gap="md">
        {!latestExport ? (
          <>
            <Text size="sm">
              Generate an incident report from this investigation. The AI will
              synthesize all findings into a structured report.
            </Text>
            <SegmentedControl
              data={[
                { label: 'Markdown', value: 'markdown' },
                { label: 'JSON', value: 'json' },
              ]}
              value={selectedFormat}
              onChange={(v) => setSelectedFormat(v as 'markdown' | 'json')}
            />
            <Button
              variant="primary"
              onClick={() => onExport(selectedFormat)}
              loading={isExporting}
            >
              Generate Report
            </Button>
          </>
        ) : (
          <>
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                Generated {new Date(latestExport.createdAt).toLocaleString()}
              </Text>
              <CopyButton value={latestExport.content}>
                {({ copied, copy }) => (
                  <Button variant="secondary" size="xs" onClick={copy}>
                    {copied ? 'Copied!' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Textarea
              value={latestExport.content}
              readOnly
              autosize
              minRows={10}
              maxRows={20}
            />
            <Button variant="secondary" onClick={() => onExport(selectedFormat)}>
              Regenerate
            </Button>
          </>
        )}
      </Stack>
    </Modal>
  );
}
```

**Step 2: Wire into detail page**

Update `packages/app/pages/investigations/[id].tsx` to import and render `InvestigationExport` modal, triggered from the Actions menu.

**Step 3: Commit**

```bash
git add packages/app/src/components/Investigation/InvestigationExport.tsx packages/app/pages/investigations/[id].tsx
git commit -m "feat(investigation): add export modal with markdown/JSON report generation"
```

---

## Task 13: Navigation — Add Investigations to App Nav

**Files:**
- Modify: `packages/app/src/components/AppNav.tsx` — add "Investigations" link

**Step 1: Find the nav items**

Read `packages/app/src/components/AppNav.tsx` and find where nav links are defined. Add an "Investigations" entry that links to `/investigations`.

**Step 2: Add the link**

Pattern: follow existing nav item structure (icon + label + href).

**Step 3: Commit**

```bash
git add packages/app/src/components/AppNav.tsx
git commit -m "feat(investigation): add Investigations link to app navigation"
```

---

## Task 14: Lint, Type Check, and Final Verification

**Step 1: Run lint and type check**

Run: `make ci-lint`
Expected: PASS — no lint or type errors

**Step 2: Run unit tests**

Run: `make ci-unit`
Expected: PASS — all existing + new tests pass

**Step 3: Fix any issues found**

Address lint errors, type errors, or test failures.

**Step 4: Final commit if fixes needed**

```bash
git add -u
git commit -m "fix: address lint and type errors in investigation feature"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Mongoose model | `models/investigation.ts` |
| 2 | CRUD controller | `controllers/investigation.ts` |
| 3 | ClickHouse schema introspection | `controllers/investigation-tools/schema.ts` |
| 4 | 7 AI tools | `controllers/investigation-tools/tools.ts` |
| 5 | Agent loop (streamText) | `controllers/investigation-agent.ts` |
| 6 | API router + SSE | `routers/api/investigations.ts` |
| 7 | React hooks | `hooks/useInvestigations.ts` |
| 8 | Chat + Message components | `components/Investigation/` |
| 9 | Side panel + trace integration | `Investigation/InvestigationSidePanel.tsx` |
| 10 | Full page (list + detail) | `pages/investigations/` |
| 11 | Alert integration | Controller + alerts page |
| 12 | Export modal | `Investigation/InvestigationExport.tsx` |
| 13 | Navigation | `AppNav.tsx` |
| 14 | Lint + type check | All files |
