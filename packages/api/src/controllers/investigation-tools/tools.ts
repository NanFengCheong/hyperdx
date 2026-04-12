import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import opentelemetry from '@opentelemetry/api';
import { dynamicTool } from 'ai';
import { performance } from 'perf_hooks';
import { z } from 'zod';

import Alert, { IAlert } from '@/models/alert';
import Dashboard from '@/models/dashboard';
import InvestigationMemory from '@/models/investigationMemory';
import { SavedSearch } from '@/models/savedSearch';
import { Source } from '@/models/source';
import logger from '@/utils/logger';

type InvestigationPhase = 'plan' | 'execute' | 'verify' | 'summarize';

const PHASE_TOOLS: Record<InvestigationPhase, string[]> = {
  plan: [
    'retrieveMemory',
    'getActiveAlerts',
    'getServiceHealthScore',
    'getServiceMap',
  ],
  execute: [
    'searchTraces',
    'searchLogs',
    'getMetrics',
    'findSimilarErrors',
    'getBaselineMetrics',
    'getServiceMap',
  ],
  verify: ['searchTraces', 'searchLogs', 'getMetrics', 'findSimilarErrors'],
  summarize: ['createSavedSearch', 'createDashboard', 'createAlert'],
};

// ---------------------------------------------------------------------------
// Tool execution wrapper with OTel tracing
// ---------------------------------------------------------------------------

const toolTracer = opentelemetry.trace.getTracer('hyperdx-investigation-tools');

/**
 * Wrap a tool's execute function with an OTel span.
 * Records duration, input/output size, and errors.
 */
function tracedExecute<T extends z.ZodTypeAny>(opts: {
  toolName: string;
  inputSchema: T;
  description: string;
  execute: (input: z.infer<T>) => Promise<string>;
  teamId: string;
}) {
  return dynamicTool({
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: async input => {
      return toolTracer.startActiveSpan(
        `investigation.tool.${opts.toolName}`,
        async span => {
          span.setAttributes({
            'hyperdx.investigation.tool.name': opts.toolName,
            'hyperdx.investigation.team.id': opts.teamId,
          });

          const start = performance.now();
          try {
            const parsed = opts.inputSchema.parse(input);
            span.setAttribute(
              'hyperdx.investigation.input_size',
              JSON.stringify(parsed).length,
            );

            const result = await opts.execute(parsed);

            span.setAttribute(
              'hyperdx.investigation.output_size',
              result.length,
            );
            span.setAttribute('hyperdx.investigation.success', true);

            return result;
          } catch (err) {
            span.recordException(err as Error);
            span.setAttribute('hyperdx.investigation.success', false);
            throw err;
          } finally {
            span.setAttribute(
              'hyperdx.investigation.tool.duration_ms',
              performance.now() - start,
            );
            span.end();
          }
        },
      );
    },
  });
}

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

const createSavedSearchInputSchema = z.object({
  name: z.string().describe('Name of the saved search'),
  kind: z.enum(['log', 'trace']).describe('Type of search'),
  where: z.string().describe('The WHERE clause for the search'),
});

const createDashboardInputSchema = z.object({
  name: z.string().describe('Name of the dashboard'),
  charts: z
    .array(
      z.object({
        title: z.string(),
        metric: z.enum(['error_rate', 'latency', 'throughput']),
        service: z.string(),
      }),
    )
    .describe('List of charts to include in the dashboard'),
});

const createAdvancedDashboardInputSchema = z.object({
  name: z.string().describe('Name of the dashboard'),
  tiles: z
    .array(
      z.object({
        title: z.string(),
        type: z
          .enum(['chart', 'search', 'number', 'markdown'])
          .default('chart'),
        select: z
          .array(
            z.object({
              aggFn: z
                .enum([
                  'count',
                  'avg',
                  'p50',
                  'p90',
                  'p95',
                  'p99',
                  'sum',
                  'max',
                  'min',
                  'uniq',
                  'count_per_hour',
                ])
                .describe('Aggregation function'),
              valueExpression: z
                .string()
                .default('')
                .describe('Column or expression to aggregate'),
              aggCondition: z
                .string()
                .optional()
                .describe('SQL condition for the aggregate'),
            }),
          )
          .describe('Series/aggregation definitions'),
        where: z.string().default('').describe('WHERE clause (Lucense or SQL)'),
        whereLanguage: z
          .enum(['lucene', 'sql'])
          .default('lucene')
          .describe('Query language for the where clause'),
        groupBy: z.array(z.string()).default([]).describe('Fields to group by'),
        granularity: z
          .enum(['auto', '1m', '5m', '15m', '1h', '6h', '1d'])
          .default('auto')
          .describe('Time bucket granularity'),
        content: z
          .string()
          .optional()
          .describe('Markdown content (if type is markdown)'),
      }),
    )
    .describe('Tiles with full chart config'),
});

const createAlertInputSchema = z.object({
  name: z
    .string()
    .describe(
      'Descriptive name for the alert, e.g. "payment-service high latency"',
    ),
  source: z
    .enum(['saved_search'])
    .describe('What type of resource this alert is based on'),
  sourceId: z.string().describe('ID of the saved search this alert monitors'),
  threshold: z.number().positive().describe('Numeric threshold value'),
  thresholdType: z
    .enum(['above', 'below'])
    .describe('Fire when value is above or below threshold'),
  interval: z
    .enum(['1m', '5m', '15m', '30m', '1h', '6h', '12h', '1d'])
    .describe('Evaluation window'),
  channelType: z
    .enum(['webhook', 'email', 'telegram', 'none'])
    .optional()
    .describe('Notification channel type'),
  webhookId: z
    .string()
    .optional()
    .describe('Webhook ID (if channelType is webhook)'),
  chatId: z
    .string()
    .optional()
    .describe('Telegram chat ID (if channelType is telegram)'),
});

const retrieveMemoryInputSchema = z.object({
  service: z.string().optional().describe('Filter by service name'),
  symptom: z
    .string()
    .optional()
    .describe('Filter by symptom pattern, e.g. "latency spike"'),
  daysBack: z
    .number()
    .int()
    .positive()
    .default(30)
    .describe('How many days back to search'),
  maxResults: z
    .number()
    .int()
    .positive()
    .default(5)
    .describe('Maximum results to return'),
});

const getBaselineMetricsInputSchema = z.object({
  service: z.string().describe('Service name'),
  metric: z
    .enum(['error_rate', 'latency_p50', 'latency_p99', 'throughput'])
    .describe('Which metric to compare'),
  comparisonWindow: z
    .enum(['1h', '24h', '7d'])
    .default('24h')
    .describe(
      'Historical baseline window: same hour yesterday, last 24h avg, or last 7d avg',
    ),
});

const getServiceHealthScoreInputSchema = z.object({
  timeRange: z.object({
    start: z.string().describe('ISO 8601 start time'),
    end: z.string().describe('ISO 8601 end time'),
  }),
  service: z
    .string()
    .optional()
    .describe('Filter to a specific service (omit for all services)'),
});

const getActiveAlertsInputSchema = z.object({
  service: z.string().optional().describe('Filter alerts by service name'),
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

export function createInvestigationTools({
  connection,
  teamId,
  userId,
  phase,
}: {
  connection: { host: string; username: string; password: string };
  teamId: string;
  userId: string;
  phase?: InvestigationPhase;
}) {
  const client = new ClickhouseClient({
    host: connection.host,
    username: connection.username,
    password: connection.password,
  });

  const searchTraces = tracedExecute({
    toolName: 'searchTraces',
    description:
      'Search for traces by service name, time range, status, or duration. Returns top matching traces.',
    inputSchema: searchTracesInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const getTraceDetail = tracedExecute({
    toolName: 'getTraceDetail',
    description:
      'Get the full span tree for a specific trace ID, including timing, attributes, events, and errors.',
    inputSchema: getTraceDetailInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const searchLogs = tracedExecute({
    toolName: 'searchLogs',
    description:
      'Search logs by text query, time range, service, and severity level.',
    inputSchema: searchLogsInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const getMetrics = tracedExecute({
    toolName: 'getMetrics',
    description:
      'Get time series metrics (error rate, latency percentiles, throughput) for a service.',
    inputSchema: getMetricsInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const findSimilarErrors = tracedExecute({
    toolName: 'findSimilarErrors',
    description:
      'Find traces and logs with similar error messages, grouped by pattern with frequency counts.',
    inputSchema: findSimilarErrorsInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const getServiceMap = tracedExecute({
    toolName: 'getServiceMap',
    description:
      'Get upstream and downstream service dependencies with edge latency and error rates.',
    inputSchema: getServiceMapInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const getSessionReplay = tracedExecute({
    toolName: 'getSessionReplay',
    description:
      'Get session replay metadata and linked trace IDs for a given trace or session ID.',
    inputSchema: getSessionReplayInputSchema,
    execute: async parsed => {
      const params = parsed;
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
    teamId,
  });

  const createSavedSearch = tracedExecute({
    toolName: 'createSavedSearch',
    description:
      'Create a saved search (Source) for the team based on a query.',
    inputSchema: createSavedSearchInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        // Find a source of the same kind to copy base settings
        const baseSource = await Source.findOne({
          team: teamId,
          kind: params.kind,
        });
        if (!baseSource) {
          return `Error: No base source found for kind ${params.kind}`;
        }

        const savedSearch = await SavedSearch.create({
          team: teamId,
          name: params.name,
          where: params.where,
          source: baseSource._id,
          createdBy: userId,
        });
        return `Successfully created saved search: ${savedSearch.name} (ID: ${savedSearch._id})`;
      } catch (err) {
        logger.error({ err }, 'createSavedSearch failed');
        return `Error creating saved search: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const createDashboard = tracedExecute({
    toolName: 'createDashboard',
    description: 'Create a new dashboard with multiple charts for the team.',
    inputSchema: createDashboardInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        const dashboard = await Dashboard.create({
          name: params.name,
          team: teamId,
          createdBy: userId,
          tiles: params.charts.map((chart, i) => ({
            id: `chart-${i}`,
            title: chart.title,
            type: 'chart',
            x: (i % 2) * 6,
            y: Math.floor(i / 2) * 4,
            w: 6,
            h: 4,
            query: {
              metric: chart.metric,
              service: chart.service,
            },
          })),
        });
        return `Successfully created dashboard: ${dashboard.name} (ID: ${dashboard._id})`;
      } catch (err) {
        logger.error({ err }, 'createDashboard failed');
        return `Error creating dashboard: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const createAdvancedDashboard = tracedExecute({
    toolName: 'createAdvancedDashboard',
    description:
      'Create a dashboard with full BuilderChartConfig tiles. Use this for precise control over aggregations, WHERE clauses, groupBy, and granularity. Prefer this over createDashboard when you need specific query configs.',
    inputSchema: createAdvancedDashboardInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        const tiles = params.tiles.map((tile, i) => {
          const baseTile = {
            id: `tile-${i}`,
            title: tile.title,
            type: tile.type,
            x: (i % 2) * 6,
            y: Math.floor(i / 2) * 4,
            w: 6,
            h: 4,
          };

          if (tile.type === 'markdown') {
            return {
              ...baseTile,
              content: tile.content || '',
            };
          }

          return {
            ...baseTile,
            query: {
              configType: 'builder' as const,
              select: tile.select,
              from: null, // Will use the default source for the team
              where: tile.where,
              whereLanguage: tile.whereLanguage,
              groupBy: tile.groupBy,
              granularity: tile.granularity,
            },
          };
        });

        const dashboard = await Dashboard.create({
          name: params.name,
          team: teamId,
          createdBy: userId,
          tiles,
        });

        return `Successfully created advanced dashboard: ${dashboard.name} (ID: ${dashboard._id}) with ${tiles.length} tiles`;
      } catch (err) {
        logger.error({ err }, 'createAdvancedDashboard failed');
        return `Error creating advanced dashboard: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const createAlert = tracedExecute({
    toolName: 'createAlert',
    description:
      'Create an alert that fires when a metric crosses a threshold. Use this to monitor patterns you discovered during investigation.',
    inputSchema: createAlertInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        // Verify the saved search exists and belongs to this team
        const savedSearch = await SavedSearch.findOne({
          _id: params.sourceId,
          team: teamId,
        });
        if (!savedSearch) {
          return `Error: Saved search ${params.sourceId} not found in your team`;
        }

        // Build channel config
        let channel: IAlert['channel'] = { type: null };
        if (params.channelType === 'webhook' && params.webhookId) {
          channel = { type: 'webhook', webhookId: params.webhookId };
        } else if (params.channelType === 'telegram' && params.chatId) {
          channel = { type: 'telegram', chatId: params.chatId };
        } else if (params.channelType === 'email') {
          channel = { type: 'email', userIds: [userId] };
        }

        const alert = await Alert.create({
          name: params.name,
          team: teamId,
          createdBy: userId,
          source: 'saved_search',
          savedSearch: savedSearch._id,
          threshold: params.threshold,
          thresholdType: params.thresholdType,
          interval: params.interval,
          channel,
          state: 'OK',
        });

        return `Successfully created alert: ${alert.name} (ID: ${alert.id}), monitoring ${savedSearch.name} with threshold ${params.thresholdType} ${params.threshold} over ${params.interval}`;
      } catch (err) {
        logger.error({ err }, 'createAlert failed');
        return `Error creating alert: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const retrieveMemory = tracedExecute({
    toolName: 'retrieveMemory',
    description:
      'Search past investigation findings to see if this pattern has been seen before. Returns root causes, recurrence counts, and what monitoring was set up.',
    inputSchema: retrieveMemoryInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - params.daysBack);

        const query: any = {
          teamId,
          resolvedAt: { $gte: cutoff },
        };
        if (params.service) {
          query['findings.service'] = params.service;
        }
        if (params.symptom) {
          query['findings.symptom'] = {
            $regex: params.symptom,
            $options: 'i',
          };
        }

        const memories = await InvestigationMemory.find(query)
          .sort({ resolvedAt: -1 })
          .limit(params.maxResults)
          .lean();

        if (memories.length === 0) {
          return 'No past investigation findings match this pattern. This may be a new issue.';
        }

        const formatted = memories.map(m => ({
          date: m.resolvedAt.toISOString(),
          triggerType: m.triggerType,
          summary: m.summary,
          confidence: m.confidence,
          findings: m.findings.map(f => ({
            service: f.service,
            symptom: f.symptom,
            rootCause: f.rootCause,
            wasVerified: f.wasVerified,
          })),
          recurrenceCount: m.recurrenceCount,
          artifactsCreated: m.artifactsCreated,
        }));

        return `Found ${memories.length} past investigation(s):\n${JSON.stringify(formatted, null, 2)}`;
      } catch (err) {
        logger.error({ err }, 'retrieveMemory failed');
        return `Error retrieving past memory: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const getBaselineMetrics = tracedExecute({
    toolName: 'getBaselineMetrics',
    description:
      'Compare a service metric against its historical baseline. Use this to determine if a current value is anomalous.',
    inputSchema: getBaselineMetricsInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

        // Compute current value (last hour)
        let currentQuery = '';
        switch (params.metric) {
          case 'error_rate':
            currentQuery = `
              SELECT
                round(countIf(StatusCode = 'ERROR') / count() * 100, 2) AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${oneHourAgo.toISOString()}'
                AND Timestamp <= '${now.toISOString()}'
            `;
            break;
          case 'latency_p50':
            currentQuery = `
              SELECT quantile(0.5)(Duration) AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${oneHourAgo.toISOString()}'
                AND Timestamp <= '${now.toISOString()}'
            `;
            break;
          case 'latency_p99':
            currentQuery = `
              SELECT quantile(0.99)(Duration) AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${oneHourAgo.toISOString()}'
                AND Timestamp <= '${now.toISOString()}'
            `;
            break;
          case 'throughput':
            currentQuery = `
              SELECT count() AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${oneHourAgo.toISOString()}'
                AND Timestamp <= '${now.toISOString()}'
            `;
            break;
        }

        // Compute baseline (historical window)
        let baselineStart: Date;
        switch (params.comparisonWindow) {
          case '1h':
            // Same hour yesterday
            baselineStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            break;
          case '24h':
            // Last 24 hours average (excluding the last hour which is "current")
            baselineStart = new Date(now.getTime() - 25 * 60 * 60 * 1000);
            break;
          case '7d':
            // Last 7 days average (excluding the last hour)
            baselineStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        }
        const baselineEnd = new Date(oneHourAgo.getTime());

        let baselineQuery = '';
        switch (params.metric) {
          case 'error_rate':
            baselineQuery = `
              SELECT
                round(countIf(StatusCode = 'ERROR') / count() * 100, 2) AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${baselineStart.toISOString()}'
                AND Timestamp <= '${baselineEnd.toISOString()}'
            `;
            break;
          case 'latency_p50':
          case 'latency_p99': {
            const aggFn = params.metric === 'latency_p50' ? '0.5' : '0.99';
            baselineQuery = `
              SELECT quantile(${aggFn})(Duration) AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${baselineStart.toISOString()}'
                AND Timestamp <= '${baselineEnd.toISOString()}'
            `;
            break;
          }
          case 'throughput':
            baselineQuery = `
              SELECT count() AS value
              FROM otel_traces
              WHERE ServiceName = {service:String}
                AND Timestamp >= '${baselineStart.toISOString()}'
                AND Timestamp <= '${baselineEnd.toISOString()}'
            `;
            break;
        }

        const [currentResult, baselineResult] = await Promise.all([
          client.query({
            query: currentQuery,
            query_params: { service: params.service },
            format: 'JSONEachRow',
          }),
          client.query({
            query: baselineQuery,
            query_params: { service: params.service },
            format: 'JSONEachRow',
          }),
        ]);

        const currentText = await currentResult.text();
        const baselineText = await baselineResult.text();
        const currentRows = JSON.parse(currentText) as Record<
          string,
          unknown
        >[];
        const baselineRows = JSON.parse(baselineText) as Record<
          string,
          unknown
        >[];

        const currentValue = (currentRows[0]?.value as number) ?? 0;
        const baselineValue = (baselineRows[0]?.value as number) ?? 0;

        const ratio =
          baselineValue > 0 ? (currentValue / baselineValue).toFixed(2) : 'N/A';

        return JSON.stringify(
          {
            service: params.service,
            metric: params.metric,
            currentValue,
            baselineValue,
            baselineWindow: params.comparisonWindow,
            ratio: `${ratio}x baseline`,
            isAnomalous:
              baselineValue > 0
                ? currentValue > baselineValue * 2 ||
                  currentValue < baselineValue * 0.5
                : false,
          },
          null,
          2,
        );
      } catch (err) {
        logger.error({ err }, 'getBaselineMetrics failed');
        return `Error getting baseline metrics: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const getServiceHealthScore = tracedExecute({
    toolName: 'getServiceHealthScore',
    description:
      'Get a computed health score (0.0-1.0) for services based on error rate, latency, and throughput. 1.0 = healthy, 0.0 = critical.',
    inputSchema: getServiceHealthScoreInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        const serviceFilter = params.service
          ? `WHERE ServiceName = {service:String}`
          : '';

        const query = `
          SELECT
            ServiceName,
            count() AS total_spans,
            countIf(StatusCode = 'ERROR') AS error_spans,
            round(error_spans / total_spans * 100, 2) AS error_rate_pct,
            quantile(0.99)(Duration) AS p99_latency,
            quantile(0.50)(Duration) AS p50_latency
          FROM otel_traces
          WHERE Timestamp >= '${params.timeRange.start}'
            AND Timestamp <= '${params.timeRange.end}'
            ${serviceFilter}
          GROUP BY ServiceName
          ORDER BY error_rate_pct DESC
          LIMIT 50
        `;

        const result = await client.query({
          query,
          query_params: { service: params.service ?? '' },
          format: 'JSONEachRow',
        });

        const text = await result.text();
        const rows = JSON.parse(text) as Record<string, unknown>[];

        // Compute health scores
        const healthScores = rows.map(row => {
          const errorRate = (row.error_rate_pct as number) ?? 0;
          const p99 = (row.p99_latency as number) ?? 0;

          // Error rate component: 0 errors = 1.0, 10%+ errors = 0.0
          const errorScore = Math.max(0, 1 - errorRate / 10);

          // Latency component: <100ms = 1.0, >5000ms = 0.0
          const latencyScore = Math.max(0, 1 - p99 / 5000);

          // Weighted: 60% error rate, 40% latency
          const healthScore =
            Math.round((errorScore * 0.6 + latencyScore * 0.4) * 100) / 100;

          return {
            service: row.ServiceName,
            healthScore,
            errorRate,
            p99Latency: p99,
            p50Latency: row.p50_latency,
            totalSpans: row.total_spans,
            status:
              healthScore >= 0.8
                ? 'healthy'
                : healthScore >= 0.5
                  ? 'degraded'
                  : 'critical',
          };
        });

        return JSON.stringify(
          {
            services: healthScores,
            unhealthyServices: healthScores.filter(s => s.status !== 'healthy'),
          },
          null,
          2,
        );
      } catch (err) {
        logger.error({ err }, 'getServiceHealthScore failed');
        return `Error getting service health scores: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const getActiveAlerts = tracedExecute({
    toolName: 'getActiveAlerts',
    description:
      'Get currently firing alerts (state = ALERT) for this team. Use this to know what problems are already being actively monitored.',
    inputSchema: getActiveAlertsInputSchema,
    execute: async parsed => {
      const params = parsed;
      try {
        const query: any = {
          team: teamId,
          state: 'ALERT',
        };

        const alerts = await Alert.find(query)
          .populate('savedSearch', 'name where')
          .populate('dashboard', 'name')
          .lean();

        let filtered = alerts;
        if (params.service) {
          // Filter alerts where the saved search or dashboard name mentions the service
          filtered = alerts.filter(a => {
            const name = (a.name || '').toLowerCase();
            const savedSearchName = (
              (a.savedSearch as any)?.name || ''
            ).toLowerCase();
            const searchTerm = params.service!.toLowerCase();
            return (
              name.includes(searchTerm) || savedSearchName.includes(searchTerm)
            );
          });
        }

        if (filtered.length === 0) {
          return `No alerts are currently firing${params.service ? ` for service "${params.service}"` : ''}.`;
        }

        const formatted = filtered.map(a => ({
          id: a.id,
          name: a.name,
          state: a.state,
          threshold: a.threshold,
          thresholdType: a.thresholdType,
          interval: a.interval,
          savedSearchName: (a.savedSearch as any)?.name,
          savedSearchWhere: (a.savedSearch as any)?.where,
        }));

        return `${filtered.length} alert(s) currently firing:\n${JSON.stringify(formatted, null, 2)}`;
      } catch (err) {
        logger.error({ err }, 'getActiveAlerts failed');
        return `Error getting active alerts: ${(err as Error).message}`;
      }
    },
    teamId,
  });

  const allTools = {
    searchTraces,
    getTraceDetail,
    searchLogs,
    getMetrics,
    findSimilarErrors,
    getServiceMap,
    getSessionReplay,
    createSavedSearch,
    createDashboard,
    createAdvancedDashboard,
    createAlert,
    retrieveMemory,
    getBaselineMetrics,
    getServiceHealthScore,
    getActiveAlerts,
  };

  if (phase) {
    const allowed = new Set(PHASE_TOOLS[phase]);
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => allowed.has(name)),
    );
  }
  return allTools;
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
