import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import { dynamicTool } from 'ai';
import { z } from 'zod';

import logger from '@/utils/logger';

// Shared time range schema
const timeRangeSchema = z.object({
  start: z.string().describe('ISO 8601 start time'),
  end: z.string().describe('ISO 8601 end time'),
});

// Individual tool input schemas (as named consts for z.infer)
const searchTracesInputSchema = z.object({
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
  query: z.string().optional().describe('Additional WHERE clause conditions'),
  fields: z
    .array(z.string())
    .optional()
    .describe('Additional columns to select'),
});

const getTraceDetailInputSchema = z.object({
  traceId: z.string().describe('The trace ID to look up'),
});

const searchLogsInputSchema = z.object({
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
});

const getMetricsInputSchema = z.object({
  service: z.string().describe('Service name'),
  metric: z
    .enum(['error_rate', 'latency', 'throughput'])
    .describe('Metric type'),
  timeRange: timeRangeSchema,
  granularity: z
    .enum(['1m', '5m', '15m', '1h'])
    .optional()
    .describe('Time bucket granularity'),
});

const findSimilarErrorsInputSchema = z.object({
  errorMessage: z.string().describe('Error message pattern to search for'),
  service: z.string().optional().describe('Filter by service name'),
  timeRange: timeRangeSchema.optional().describe('Time range to search'),
});

const getServiceMapInputSchema = z.object({
  service: z.string().optional().describe('Center service (omit for full map)'),
  timeRange: timeRangeSchema,
});

const getSessionReplayInputSchema = z.object({
  traceId: z.string().optional().describe('Find session linked to this trace'),
  sessionId: z.string().optional().describe('Direct session ID lookup'),
});

// Helper to format results for AI consumption (truncate large results)
async function formatForAI(
  result: Awaited<ReturnType<InstanceType<typeof ClickhouseClient>['query']>>,
  maxRows = 20,
): Promise<string> {
  const text = await result.text();
  const rows = JSON.parse(text) as Record<string, unknown>[];
  const truncated = rows.slice(0, maxRows);
  const resultStr = JSON.stringify(truncated, null, 2);
  if (rows.length > maxRows) {
    return `${resultStr}\n... (${rows.length - maxRows} more rows truncated)`;
  }
  return resultStr;
}

export function createInvestigationTools(connection: {
  host: string;
  username: string;
  password: string;
}) {
  const client = new ClickhouseClient({
    host: connection.host,
    username: connection.username,
    password: connection.password,
  });

  const searchTraces = dynamicTool({
    description:
      'Search for traces by service name, time range, status, or duration. Returns top matching traces.',
    inputSchema: searchTracesInputSchema,
    execute: async input => {
      const params = searchTracesInputSchema.parse(input);
      const conditions: string[] = [
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
        const result = await client.query({
          query,
          query_params: {
            service: params.service ?? '',
            status: params.status ?? '',
            minDuration: params.minDuration ?? 0,
          },
          format: 'JSONEachRow',
        });
        return await formatForAI(result);
      } catch (err) {
        logger.error({ err, query }, 'searchTraces failed');
        return `Error searching traces: ${(err as Error).message}`;
      }
    },
  });

  const getTraceDetail = dynamicTool({
    description:
      'Get the full span tree for a specific trace ID, including timing, attributes, events, and errors.',
    inputSchema: getTraceDetailInputSchema,
    execute: async input => {
      const params = getTraceDetailInputSchema.parse(input);
      const query = `
        SELECT TraceId, SpanId, ParentSpanId, SpanName, ServiceName,
               Duration, StatusCode, StatusMessage,
               SpanAttributes, ResourceAttributes, Events
        FROM otel_traces
        WHERE TraceId = {traceId:String}
        ORDER BY Timestamp ASC
      `;

      try {
        const result = await client.query({
          query,
          query_params: { traceId: params.traceId },
          format: 'JSONEachRow',
        });
        return await formatForAI(result, 50);
      } catch (err) {
        logger.error({ err }, 'getTraceDetail failed');
        return `Error getting trace detail: ${(err as Error).message}`;
      }
    },
  });

  const searchLogs = dynamicTool({
    description:
      'Search logs by text query, time range, service, and severity level.',
    inputSchema: searchLogsInputSchema,
    execute: async input => {
      const params = searchLogsInputSchema.parse(input);
      const conditions: string[] = [
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
        const result = await client.query({
          query,
          query_params: {
            query: `%${params.query}%`,
            service: params.service ?? '',
            level: params.level ?? '',
          },
          format: 'JSONEachRow',
        });
        return await formatForAI(result, 50);
      } catch (err) {
        logger.error({ err }, 'searchLogs failed');
        return `Error searching logs: ${(err as Error).message}`;
      }
    },
  });

  const getMetrics = dynamicTool({
    description:
      'Get time series metrics (error rate, latency percentiles, throughput) for a service.',
    inputSchema: getMetricsInputSchema,
    execute: async input => {
      const params = getMetricsInputSchema.parse(input);
      const granularity = params.granularity ?? '5m';
      const granularitySecondsMap: Record<string, number> = {
        '1m': 60,
        '5m': 300,
        '15m': 900,
        '1h': 3600,
      };
      const granularitySeconds = granularitySecondsMap[granularity] ?? 300;

      let query = '';

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
        const result = await client.query({
          query,
          query_params: { service: params.service },
          format: 'JSONEachRow',
        });
        return await formatForAI(result, 100);
      } catch (err) {
        logger.error({ err }, 'getMetrics failed');
        return `Error getting metrics: ${(err as Error).message}`;
      }
    },
  });

  const findSimilarErrors = dynamicTool({
    description:
      'Find traces and logs with similar error messages, grouped by pattern with frequency counts.',
    inputSchema: findSimilarErrorsInputSchema,
    execute: async input => {
      const params = findSimilarErrorsInputSchema.parse(input);
      const timeFilter = params.timeRange
        ? `AND Timestamp >= '${params.timeRange.start}' AND Timestamp <= '${params.timeRange.end}'`
        : 'AND Timestamp >= now() - INTERVAL 24 HOUR';
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
        const result = await client.query({
          query,
          query_params: {
            errorPattern: `%${params.errorMessage}%`,
            service: params.service ?? '',
          },
          format: 'JSONEachRow',
        });
        return await formatForAI(result);
      } catch (err) {
        logger.error({ err }, 'findSimilarErrors failed');
        return `Error finding similar errors: ${(err as Error).message}`;
      }
    },
  });

  const getServiceMap = dynamicTool({
    description:
      'Get upstream and downstream service dependencies with edge latency and error rates.',
    inputSchema: getServiceMapInputSchema,
    execute: async input => {
      const params = getServiceMapInputSchema.parse(input);
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
        const result = await client.query({
          query,
          query_params: { service: params.service ?? '' },
          format: 'JSONEachRow',
        });
        return await formatForAI(result, 50);
      } catch (err) {
        logger.error({ err }, 'getServiceMap failed');
        return `Error getting service map: ${(err as Error).message}`;
      }
    },
  });

  const getSessionReplay = dynamicTool({
    description:
      'Get session replay metadata and linked trace IDs for a given trace or session ID.',
    inputSchema: getSessionReplayInputSchema,
    execute: async input => {
      const params = getSessionReplayInputSchema.parse(input);
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

        const result = await client.query({
          query: sessionQuery,
          query_params: { id: params.sessionId ?? params.traceId ?? '' },
          format: 'JSONEachRow',
        });
        return await formatForAI(result);
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
  description:
    'Search for traces by service name, time range, status, or duration.',
  inputSchema: z.object({
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
  inputSchema: z.object({
    traceId: z.string(),
  }),
};

export const searchLogsTool = {
  name: 'searchLogs',
  description: 'Search logs by text query and filters.',
  inputSchema: z.object({
    query: z.string(),
    timeRange: z.object({ start: z.string(), end: z.string() }),
    service: z.string().optional(),
    level: z.string().optional(),
    fields: z.array(z.string()).optional(),
  }),
};
