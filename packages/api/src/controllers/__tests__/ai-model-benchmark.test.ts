/**
 * AI Model Benchmark — Tests multiple models against
 * AssistantLineTableConfigSchema using the DashScope Chat Completions API.
 *
 * Run:
 *   DASHSCOPE_API_KEY=<key> npx jest --no-coverage --forceExit \
 *     src/controllers/__tests__/ai-model-benchmark.test.ts
 *
 * Override models:
 *   BENCHMARK_MODELS=qwen3-max,qwen-max npx jest ...
 */

import { AssistantLineTableConfigSchema } from '@hyperdx/common-utils/dist/types';

// Use native https (jest.setup.ts mocks global.fetch, so we bypass it)

const https = require('https');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_KEY = process.env.DASHSCOPE_API_KEY ?? process.env.AI_API_KEY ?? '';
const BASE_URL =
  process.env.DASHSCOPE_BASE_URL ??
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

const MODELS_TO_TEST: string[] = (
  process.env.BENCHMARK_MODELS ??
  [
    'qwen3-max-2026-01-23',
    'qwen3.6-plus',
    'qwen3-max',
    'qwen-max',
    'qwen-max-2025-01-25',
    'qwen3.5-plus',
    'qwen3.5-397b-a17b',
    'qwen3-235b-a22b',
    'qwen-plus-latest',
    'qwen3-coder-plus',
    'deepseek-v3.2',
  ].join(',')
).split(',');

// ---------------------------------------------------------------------------
// Prompt (mirrors packages/api/src/routers/api/ai.ts)
// ---------------------------------------------------------------------------
const BENCHMARK_PROMPT = `You are an AI assistant that helps users create chart configurations for an observability platform called HyperDX.

The user wants to create a chart based on the following description:
all error related to assistant for past 2 hours

Generate a visualization or search that matches their request. The chart should query logs, metrics, or traces from a ClickHouse database.

Here are some guidelines:
- Use appropriate display types: 'line' for time series, 'table' for tabular data
- Use appropriate aggregate functions depending on user's request: 'count', 'sum', 'avg', 'min', 'max', 'count_distinct'
- If the user is requesting for a specific set of data (ex. "frontend service", filter the condition by the appropriate property based on the below properties ex. \`ServiceName = 'frontend'\`)
- Pick an appropriate time range based on the user's request if one can be inferred from the request.

The user is looking to do a query on their data source named: Traces of type trace.

The span status code is stored in StatusCode.
You can identify services via ServiceName
Duration of spans can be queried via Duration which is expressed in 10^-9 seconds of precision.
Span names under SpanName and span kinds under SpanKind
Various log/span-specific attributes as a Map can be found under SpanAttributes while resource attributes that follow the OpenTelemetry semantic convention can be found under ResourceAttributes
You must use the full field name ex. "column['key']" or "column.key" as it appears.

The following is a list of properties and example values that exist in the source:
[{"key":"ServiceName","value":["hdx-oss-dev-app","msm-apisix","hdx-oss-app"]},{"key":"SpanName","value":["GET /api/v1/traces","POST /api/v1/charts/series","/"]},{"key":"StatusCode","value":["Error","Unset"]},{"key":"SpanKind","value":["Server","Internal","Client"]},{"key":"ResourceAttributes","value":[{"service.name":"hdx-oss-dev-app","deployment.environment":"dev"}]}]

There may be additional properties that you can use as well:
[{"field":"ServiceName","type":"LowCardinality(String)"},{"field":"SpanName","type":"LowCardinality(String)"},{"field":"StatusCode","type":"LowCardinality(String)"},{"field":"SpanKind","type":"LowCardinality(String)"},{"field":"Duration","type":"UInt64"},{"field":"SpanAttributes","type":"Map(LowCardinality(String), String)"},{"field":"ResourceAttributes","type":"Map(LowCardinality(String), String)"},{"field":"ResourceAttributes['service.name']","type":"String"}]

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

// ---------------------------------------------------------------------------
// Normalization (from ai.ts — tests fallback path)
// ---------------------------------------------------------------------------
function normalizeAIResponse(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;

  const items = obj.select ?? obj.series ?? obj.queries;
  if (Array.isArray(items) && !obj.select) {
    obj.select = items.map((item: Record<string, unknown>) => {
      const aggFn =
        item.aggregationFunction ?? item.aggregateFunction ?? 'count';
      const property = item.property ?? item.field ?? '';
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

  if (obj.timeRange != null && typeof obj.timeRange === 'object') {
    const tr = obj.timeRange as Record<string, string>;
    const from = tr.from ?? '';
    const match = from.match(/^now-(\d+)([mhd])$/);
    if (match) {
      const units: Record<string, string> = { m: 'min', h: 'h', d: 'd' };
      obj.timeRange = `Past ${match[1]}${units[match[2]] ?? match[2]}`;
    } else {
      obj.timeRange = 'Past 1h';
    }
  }

  return obj;
}

function tryParseAIResponse(rawText: string) {
  const candidates: string[] = [];
  const jsonMatch = rawText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) candidates.push(jsonMatch[1]);
  candidates.push(rawText.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeAIResponse(parsed);
      return AssistantLineTableConfigSchema.parse(normalized);
    } catch {
      // continue
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Raw Chat Completions API call (avoids ai-sdk fetch/headers issues in jest)
// ---------------------------------------------------------------------------
interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  finishReason: string;
}

async function callChatCompletion(
  modelName: string,
  prompt: string,
): Promise<ChatCompletionResult> {
  const url = `${BASE_URL}/chat/completions`;

  const payload = JSON.stringify({
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  const rawJson = await new Promise<string>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`API ${res.statusCode}: ${body.slice(0, 200)}`));
          } else {
            resolve(body);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  let data: {
    choices?: Array<{
      message: { content: string; reasoning_content?: string };
      finish_reason: string;
    }>;
    output?: {
      choices?: Array<{
        message: { content: string };
        finish_reason: string;
      }>;
      text?: string;
    };
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  try {
    data = JSON.parse(rawJson);
  } catch {
    throw new Error(`Invalid JSON response: ${rawJson.slice(0, 200)}`);
  }

  // DashScope may use "output.choices" or top-level "choices"
  const choices = data.choices ?? data.output?.choices;
  const choice = choices?.[0];
  if (!choice) {
    throw new Error(`No choices in response: ${rawJson.slice(0, 300)}`);
  }

  return {
    content: choice.message.content ?? data.output?.text ?? '',
    inputTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
    outputTokens:
      data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
    reasoningTokens:
      data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    finishReason: choice.finish_reason,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface BenchmarkResult {
  model: string;
  durationMs: number;
  schemaValidDirect: boolean;
  schemaValidNormalized: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  rawText: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('AI Model Benchmark — AssistantLineTableConfigSchema', () => {
  jest.setTimeout(120_000);

  const results: BenchmarkResult[] = [];

  afterAll(() => {
    console.log('\n' + '='.repeat(160));
    console.log('AI MODEL BENCHMARK RESULTS');
    console.log('='.repeat(160));
    console.log(
      [
        'Model'.padEnd(35),
        'Time(ms)'.padStart(10),
        'Direct'.padStart(8),
        'Normlzd'.padStart(9),
        'In Tok'.padStart(10),
        'Out Tok'.padStart(10),
        'Reason'.padStart(10),
        'Status / Error',
      ].join(' | '),
    );
    console.log('-'.repeat(160));

    for (const r of results) {
      const status = r.schemaValidDirect
        ? 'PASS'
        : r.schemaValidNormalized
          ? 'NORM'
          : 'FAIL';
      console.log(
        [
          r.model.padEnd(35),
          String(r.durationMs).padStart(10),
          (r.schemaValidDirect ? '✓' : '✗').padStart(8),
          (r.schemaValidNormalized ? '✓' : '✗').padStart(9),
          String(r.inputTokens).padStart(10),
          String(r.outputTokens).padStart(10),
          String(r.reasoningTokens).padStart(10),
          r.error
            ? r.error.slice(0, 50)
            : status === 'PASS'
              ? 'Schema-valid on first parse'
              : status === 'NORM'
                ? 'Required normalization fallback'
                : 'Schema mismatch',
        ].join(' | '),
      );
    }

    console.log('='.repeat(160));
    const directPass = results.filter(r => r.schemaValidDirect).length;
    const normPass = results.filter(r => r.schemaValidNormalized).length;
    const totalPass = results.filter(
      r => r.schemaValidDirect || r.schemaValidNormalized,
    ).length;
    console.log(
      `\nTotal: ${results.length} | Direct: ${directPass} | +Normalized: ${normPass} | Combined pass: ${totalPass} | Failed: ${results.length - totalPass}`,
    );

    // Print raw output for failed models
    const failed = results.filter(
      r => !r.schemaValidDirect && !r.schemaValidNormalized && r.rawText,
    );
    if (failed.length > 0) {
      console.log('\n--- Failed model raw outputs (first 300 chars) ---');
      for (const r of failed) {
        console.log(`\n[${r.model}]:`);
        console.log(r.rawText.slice(0, 300));
      }
    }
    console.log('');
  });

  it.each(MODELS_TO_TEST)('benchmark %s', async modelName => {
    const result: BenchmarkResult = {
      model: modelName,
      durationMs: 0,
      schemaValidDirect: false,
      schemaValidNormalized: false,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      rawText: '',
    };

    const start = performance.now();

    try {
      const apiResult = await callChatCompletion(modelName, BENCHMARK_PROMPT);

      result.durationMs = Math.round(performance.now() - start);
      result.rawText = apiResult.content;
      result.inputTokens = apiResult.inputTokens;
      result.outputTokens = apiResult.outputTokens;
      result.reasoningTokens = apiResult.reasoningTokens;

      // Try direct schema validation
      try {
        AssistantLineTableConfigSchema.parse(JSON.parse(apiResult.content));
        result.schemaValidDirect = true;
        result.schemaValidNormalized = true;
      } catch {
        // Try normalization fallback
        const parsed = tryParseAIResponse(apiResult.content);
        if (parsed) {
          result.schemaValidNormalized = true;
        }
      }
    } catch (err) {
      result.durationMs = Math.round(performance.now() - start);
      result.error = (err as Error).message?.slice(0, 100);
    }

    results.push(result);

    // Test passes if either direct or normalized parsing works
    if (result.error) {
      console.warn(`[${modelName}] API error: ${result.error}`);
    }
    expect(
      result.schemaValidDirect || result.schemaValidNormalized,
    ).toBeTruthy();
  });
});
