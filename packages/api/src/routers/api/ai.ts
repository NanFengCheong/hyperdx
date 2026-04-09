import {
  AssistantLineTableConfigSchema,
  SourceKind,
} from '@hyperdx/common-utils/dist/types';
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
} from 'ai';
import express from 'express';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import {
  getAIMetadata,
  getAIModel,
  getChartConfigFromResolvedConfig,
} from '@/controllers/ai';
import { getSource } from '@/controllers/sources';
import { getNonNullUserWithTeam } from '@/middleware/auth';
import { Api404Error, Api500Error } from '@/utils/errors';
import logger from '@/utils/logger';
import { objectIdSchema } from '@/utils/zod';

/**
 * Attempts to normalize a raw AI response object into the expected
 * AssistantLineTableConfigSchema shape. Some models (e.g. Qwen) return
 * structurally different JSON — using "series" instead of "select",
 * "aggregateFunction" instead of "aggregationFunction", "conditions"
 * arrays instead of a single "condition" string, and "timeRange" as an
 * object instead of a string. This function handles those mappings.
 */
function normalizeAIResponse(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') {
    return raw;
  }

  const obj = raw as Record<string, unknown>;

  // Map "series" → "select" when "select" is missing
  const items = obj.select ?? obj.series ?? obj.queries;
  if (Array.isArray(items) && !obj.select) {
    obj.select = items.map((item: Record<string, unknown>) => {
      const aggFn =
        item.aggregationFunction ?? item.aggregateFunction ?? 'count';

      const property = item.property ?? item.field ?? '';

      // Flatten a "conditions" array into a single SQL condition string
      let condition = item.condition;
      if (!condition && Array.isArray(item.conditions)) {
        condition = item.conditions
          .map((c: Record<string, unknown>) => {
            const field = c.field ?? c.column ?? '';
            const op = c.operator ?? '=';
            const val = c.value ?? '';
            return `${field} ${op} '${val}'`;
          })
          .join(' AND ');
      }

      // Hoist timeRange from the series item to root if missing at root
      if (obj.timeRange == null && item.timeRange != null) {
        obj.timeRange = item.timeRange;
      }

      return {
        aggregationFunction: aggFn,
        property,
        ...(condition ? { condition } : {}),
      };
    });
    delete obj.series;
    delete obj.queries;
  }

  // Normalize timeRange from object {from, to} to a descriptive string
  if (obj.timeRange != null && typeof obj.timeRange === 'object') {
    const tr = obj.timeRange as Record<string, string>;
    const from = tr.from ?? '';
    // Convert "now-2h" style to "Past 2h"
    const match = from.match(/^now-(\d+)([mhd])$/);
    if (match) {
      const units: Record<string, string> = {
        m: 'min',
        h: 'h',
        d: 'd',
      };
      obj.timeRange = `Past ${match[1]}${units[match[2]] ?? match[2]}`;
    } else {
      obj.timeRange = 'Past 1h';
    }
  }

  return obj;
}

/**
 * Try to extract a valid config from raw AI text output. Attempts in order:
 * 1. Extract JSON from markdown code blocks
 * 2. Parse the raw text as JSON directly
 * Each attempt applies normalization before schema validation.
 */
function tryParseAIResponse(
  rawText: string,
): z.infer<typeof AssistantLineTableConfigSchema> | null {
  const candidates: string[] = [];

  // Try markdown-wrapped JSON first
  const jsonMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    candidates.push(jsonMatch[1]);
  }

  // Try raw text as JSON
  candidates.push(rawText.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeAIResponse(parsed);
      return AssistantLineTableConfigSchema.parse(normalized);
    } catch {
      // continue to next candidate
    }
  }

  return null;
}

const router = express.Router();

router.post(
  '/assistant',
  validateRequest({
    body: z.object({
      text: z.string().min(1).max(10000),
      sourceId: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const model = getAIModel();

      const { teamId } = getNonNullUserWithTeam(req);

      const { text, sourceId } = req.body;

      const source = await getSource(teamId.toString(), sourceId);

      if (source == null) {
        logger.error({ message: 'invalid source id', sourceId, teamId });
        throw new Api404Error('Invalid source');
      }

      const { allFieldsWithKeys, keyValues } = await getAIMetadata(source);

      const prompt = `You are an AI assistant that helps users create chart configurations for an observability platform called HyperDX.

The user wants to create a chart based on the following description:
${text}

Generate a visualization or search that matches their request. The chart should query logs, metrics, or traces from a ClickHouse database.

Here are some guidelines:
- Use appropriate display types: 'line' for time series, 'table' for tabular data
- Use appropriate aggregate functions depending on user's request: 'count', 'sum', 'avg', 'min', 'max', 'count_distinct'
- If the user is requesting for a specific set of data (ex. "frontend service", filter the condition by the appropriate property based on the below properties ex. \`ServiceName = 'frontend'\`)
- Pick an appropriate time range based on the user's request if one can be inferred from the request.

The user is looking to do a query on their data source named: ${source.name} of type ${source.kind}.

${
  source.kind === SourceKind.Log
    ? `The log level is stored in ${source.severityTextExpression}.`
    : source.kind === SourceKind.Trace
      ? `The span status code is stored in ${source.statusCodeExpression}.`
      : ''
}
${'serviceNameExpression' in source ? `You can identify services via ${source.serviceNameExpression}` : ''}
${
  source.kind === SourceKind.Trace
    ? `Duration of spans can be queried via ${source.durationExpression} which is expressed in 10^-${source.durationPrecision} seconds of precision.
Span names under ${source.spanNameExpression} and span kinds under ${source.spanKindExpression}`
    : 'bodyExpression' in source
      ? `The log body can be queried via ${source.bodyExpression}`
      : ''
}
${
  source.kind === SourceKind.Trace || source.kind === SourceKind.Log
    ? `Various log/span-specific attributes as a Map can be found under ${source.eventAttributesExpression} while resource attributes that follow the OpenTelemetry semantic convention can be found under ${source.resourceAttributesExpression}
You must use the full field name ex. "column['key']" or "column.key" as it appears.`
    : ''
}

The following is a list of properties and example values that exist in the source:
${JSON.stringify(keyValues)}

There may be additional properties that you can use as well:
${JSON.stringify(allFieldsWithKeys.slice(0, 200).map(f => ({ field: f.key, type: f.type })))}

You MUST respond with ONLY a valid JSON object matching the schema below. Do NOT wrap it in markdown code blocks. Do NOT include any explanation or text before or after the JSON. Output raw JSON only.

Required JSON schema:
{
  "displayType": "line" | "table",
  "select": [
    {
      "aggregationFunction": one of "avg" | "count" | "count_distinct" | "last_value" | "max" | "min" | "quantile" | "sum" | "any" | "none",
      "property": "column name to aggregate (use empty string for count)",
      "condition": "optional SQL WHERE condition, e.g. SeverityText = 'error' AND Body ILIKE '%timeout%'"
    }
  ],
  "groupBy": "optional column name to group by",
  "timeRange": "time range string, e.g. Past 15min, Past 1h, Past 4h, Past 1d, Past 7d",
  "markdown": "optional markdown description of the chart"
}

Example — count of error logs in the past 2 hours:
{"displayType":"line","select":[{"aggregationFunction":"count","property":"","condition":"SeverityText = 'error'"}],"timeRange":"Past 2h"}
`;

      logger.info(prompt);

      try {
        const result = await generateText({
          model,
          output: Output.object({
            schema: AssistantLineTableConfigSchema,
          }),
          experimental_telemetry: { isEnabled: true },
          prompt,
        });

        const chartConfig = getChartConfigFromResolvedConfig(
          result.output,
          source,
        );

        return res.json(chartConfig);
      } catch (err) {
        if (err instanceof APICallError) {
          throw new Api500Error(
            `AI Provider Error. Status: ${err.statusCode}. Message: ${err.message}`,
          );
        }
        if (NoObjectGeneratedError.isInstance(err)) {
          // Some models (e.g. Qwen via DashScope) wrap JSON in markdown
          // code blocks or return structurally different JSON. Try to
          // extract, normalize, and parse the response before giving up.
          const rawText = err.text;
          if (rawText) {
            const parsed = tryParseAIResponse(rawText);
            if (parsed) {
              const chartConfig = getChartConfigFromResolvedConfig(
                parsed,
                source,
              );
              return res.json(chartConfig);
            }
            logger.warn({
              message:
                'AI response could not be parsed or normalized into a valid chart config',
              rawText: rawText.slice(0, 500),
            });
          }
          throw new Api500Error(
            'The AI was unable to generate a valid chart configuration. Please try rephrasing your request.',
          );
        }
        throw err;
      }
    } catch (e) {
      next(e);
    }
  },
);

export default router;
