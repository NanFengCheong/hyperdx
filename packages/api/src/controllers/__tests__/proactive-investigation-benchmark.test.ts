/**
 * Proactive Investigation Agent Benchmark — Native Tool Calling
 *
 * Tests 5 candidate models on the multi-phase investigation loop using
 * OpenAI-compatible function calling. Enforces tool use with tool_choice.
 *
 * Multi-turn loop per model:
 *   Turn 1 (hypothesize): system+user → free text hypotheses
 *   Turn 2 (gather):      tool_choice="required" → model MUST call tools
 *   Turn N (gather cont): inject mock results → model calls more tools (max 6 rounds)
 *   Final turn (report):  tool_choice="none"   → produce structured JSON finding
 *
 * Measures: tool call count, unique tools, finding quality, latency, tokens.
 *
 * Run:
 *   DASHSCOPE_API_KEY=<key> npx jest --no-coverage --forceExit --testTimeout=300000 \
 *     src/controllers/__tests__/proactive-investigation-benchmark.test.ts
 *
 * Override models:
 *   BENCHMARK_MODELS=qwen3-max,qwen3-plus npx jest ...
 *
 * Enable thinking mode:
 *   ENABLE_THINKING=true npx jest ...
 */

const https = require('https');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_KEY = process.env.DASHSCOPE_API_KEY ?? process.env.AI_API_KEY ?? '';
const BASE_URL =
  process.env.DASHSCOPE_BASE_URL ??
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const ENABLE_THINKING = process.env.ENABLE_THINKING === 'true';
const MAX_GATHER_ROUNDS = 6; // max tool-call rounds before forcing report

const MODELS_TO_TEST: string[] = (
  process.env.BENCHMARK_MODELS ??
  [
    'qwen3-max',          // Most capable reasoning model
    'qwen3-235b-a22b',    // Largest open-source MoE (plan's reference model)
    'qwen3.5-plus',       // Latest balanced model (Qwen3.5 series)
    'qwen3-coder-plus',   // Best tool-calling capability
    'qwen-plus-latest',   // Stable plus tier baseline
  ].join(',')
).split(',');

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
const SCENARIO = {
  service: 'payment-service',
  trigger: 'Error rate spiked from 0.5% to 12% in the last 30 minutes',
  triggerType: 'anomaly' as const,
  fingerprint: 'a3f9c2d1',
};

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'searchLogs',
      description: 'Search recent log entries for a service. Returns matching log lines with timestamps and levels.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name to search logs for' },
          query: { type: 'string', description: 'Search keyword or error message fragment' },
          timeRange: { type: 'string', description: 'Time range, e.g. "Past 30m", "Past 1h"' },
          limit: { type: 'number', description: 'Max number of log entries (default 20)' },
        },
        required: ['service', 'query', 'timeRange'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'queryMetrics',
      description: 'Query time-series metrics for a service. Supported metrics: error_rate, latency_p99, latency_p50, throughput, cpu_usage, memory_usage.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name' },
          metric: { type: 'string', description: 'Metric name: error_rate | latency_p99 | latency_p50 | throughput | cpu_usage | memory_usage' },
          timeRange: { type: 'string', description: 'Time range, e.g. "Past 30m", "Past 2h"' },
        },
        required: ['service', 'metric', 'timeRange'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchTraces',
      description: 'Search distributed traces and spans for a service. Useful for finding slow or failed requests.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name' },
          status: { type: 'string', enum: ['error', 'ok', 'all'], description: 'Span status filter (default: error)' },
          minDurationMs: { type: 'number', description: 'Minimum span duration in milliseconds' },
          timeRange: { type: 'string', description: 'Time range, e.g. "Past 30m"' },
        },
        required: ['service', 'timeRange'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'getActiveAlerts',
      description: 'Get all currently firing alerts for the team. Returns alert names, thresholds, and current values.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'searchPastInvestigations',
      description: 'Search historical investigation memory for similar past incidents on this service.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Service name to search history for' },
          symptom: { type: 'string', description: 'Symptom or error description to search for' },
          fingerprint: { type: 'string', description: 'Optional fingerprint hash to match exactly' },
        },
        required: ['service', 'symptom'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Mock tool result factory
// ---------------------------------------------------------------------------
function getMockToolResult(toolName: string, args: Record<string, unknown>): unknown {
  switch (toolName) {
    case 'searchLogs':
      return {
        hits: [
          { timestamp: '2026-04-12T04:01:23Z', level: 'error', message: 'Connection timeout to postgres-primary:5432 after 5000ms', service: args.service },
          { timestamp: '2026-04-12T04:01:45Z', level: 'error', message: 'Connection timeout to postgres-primary:5432 after 5000ms', service: args.service },
          { timestamp: '2026-04-12T04:02:01Z', level: 'error', message: 'Max connection pool size exceeded (100/100 connections active)', service: args.service },
          { timestamp: '2026-04-12T04:02:18Z', level: 'error', message: 'Failed to acquire DB connection after 30s wait', service: args.service },
        ],
        total: 847,
      };
    case 'queryMetrics':
      return {
        metric: args.metric,
        service: args.service,
        data: [
          { time: '2026-04-12T03:30:00Z', value: args.metric === 'error_rate' ? 0.005 : args.metric === 'latency_p99' ? 120 : 450 },
          { time: '2026-04-12T03:45:00Z', value: args.metric === 'error_rate' ? 0.006 : args.metric === 'latency_p99' ? 125 : 448 },
          { time: '2026-04-12T04:00:00Z', value: args.metric === 'error_rate' ? 0.12 : args.metric === 'latency_p99' ? 5230 : 52 },
          { time: '2026-04-12T04:15:00Z', value: args.metric === 'error_rate' ? 0.115 : args.metric === 'latency_p99' ? 5180 : 48 },
        ],
        insight: 'Spike began at 04:00 UTC, coinciding with DB connection pool saturation',
      };
    case 'searchTraces':
      return {
        spans: [
          { traceId: 'abc123', spanName: 'ProcessPayment', durationMs: 5230, status: 'error', rootError: 'db: connection timeout', dbSystem: 'postgresql', dbOperation: 'SELECT' },
          { traceId: 'abc124', spanName: 'ProcessPayment', durationMs: 5210, status: 'error', rootError: 'db: connection timeout', dbSystem: 'postgresql', dbOperation: 'INSERT' },
          { traceId: 'abc125', spanName: 'ProcessPayment', durationMs: 5195, status: 'error', rootError: 'db: connection pool exhausted (100/100)', dbSystem: 'postgresql' },
        ],
        total: 312,
        p99DurationMs: 5230,
      };
    case 'getActiveAlerts':
      return {
        alerts: [
          { name: 'payment-service error rate > 5%', state: 'ALERT', threshold: 0.05, currentValue: 0.12, firedAt: '2026-04-12T04:00:47Z' },
          { name: 'postgres-primary connection pool > 90%', state: 'ALERT', threshold: 0.9, currentValue: 1.0, firedAt: '2026-04-12T03:59:12Z' },
        ],
      };
    case 'searchPastInvestigations':
      return {
        memories: [
          {
            date: '2026-03-15',
            service: args.service,
            rootCause: 'DB connection pool exhaustion during high-traffic event',
            resolution: 'Increased max pool size from 50 to 200 in pg config',
            recurrenceCount: 2,
          },
        ],
      };
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a proactive observability investigation agent. You investigate production incidents autonomously.

## Your task
Investigate the triggered incident using the provided tools. You MUST:
1. First form hypotheses about possible root causes
2. Then call tools to gather evidence (you MUST call at least 3 different tools)
3. Synthesize evidence into a structured finding

## Available tools
- searchLogs: search error/warn log messages
- queryMetrics: get time-series for error_rate, latency_p99, throughput
- searchTraces: find slow/failed distributed traces
- getActiveAlerts: see what other alerts are firing
- searchPastInvestigations: check if this pattern occurred before

## Trigger context
Service: ${SCENARIO.service}
Trigger: ${SCENARIO.trigger}
Type: ${SCENARIO.triggerType}
Fingerprint: ${SCENARIO.fingerprint}`;

const REPORT_PROMPT = `Based on all evidence gathered, produce your final investigation finding as a JSON object only (no markdown, no prose):

{
  "summary": "1-2 sentence description of what happened",
  "rootCause": "specific technical root cause",
  "confidence": "high" | "medium" | "low",
  "affectedServices": ["service1"],
  "evidence": ["evidence item 1", "evidence item 2"],
  "recommendation": "specific action to fix the issue"
}`;

// ---------------------------------------------------------------------------
// API call (single turn)
// ---------------------------------------------------------------------------
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface ApiMessage {
  role: MessageRole;
  content?: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

interface TurnResult {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  finishReason: string;
}

async function callAPI(
  modelName: string,
  messages: ApiMessage[],
  toolChoice: 'auto' | 'required' | 'none' = 'auto',
): Promise<TurnResult> {
  const payload: Record<string, unknown> = {
    model: modelName,
    messages,
    temperature: 0.6,
    enable_thinking: ENABLE_THINKING,
    ...(ENABLE_THINKING ? { thinking_budget: 2048 } : {}),
    parallel_tool_calls: false, // per plan: one tool call at a time
    ...(toolChoice !== 'none'
      ? { tools: TOOL_DEFINITIONS, tool_choice: toolChoice }
      : {}),
  };

  const payloadStr = JSON.stringify(payload);

  const rawJson = await new Promise<string>((resolve, reject) => {
    const parsedUrl = new URL(`${BASE_URL}/chat/completions`);
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(payloadStr),
        },
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(new Error(`API ${res.statusCode}: ${body.slice(0, 400)}`));
          } else {
            resolve(body);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });

  const data = JSON.parse(rawJson) as {
    choices?: Array<{
      message: {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
      finish_reason: string;
    }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  const choice = data.choices?.[0];
  if (!choice) throw new Error(`No choices in response: ${rawJson.slice(0, 300)}`);

  const toolCalls = (choice.message.tool_calls ?? []).map(tc => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(tc.function.arguments); } catch { /* keep empty */ }
    return { id: tc.id, name: tc.function.name, args };
  });

  return {
    content: choice.message.content ?? null,
    toolCalls,
    inputTokens: data.usage?.prompt_tokens ?? data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? data.usage?.output_tokens ?? 0,
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    finishReason: choice.finish_reason,
  };
}

// ---------------------------------------------------------------------------
// Multi-turn investigation runner
// ---------------------------------------------------------------------------
interface InvestigationRun {
  totalToolCalls: number;
  uniqueTools: Set<string>;
  toolCallLog: Array<{ name: string; args: Record<string, unknown> }>;
  finding: Record<string, unknown> | null;
  findingValid: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  gatherRounds: number;
  error?: string;
}

async function runInvestigation(modelName: string): Promise<InvestigationRun> {
  const run: InvestigationRun = {
    totalToolCalls: 0,
    uniqueTools: new Set(),
    toolCallLog: [],
    finding: null,
    findingValid: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    gatherRounds: 0,
  };

  const messages: ApiMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Investigate: ${SCENARIO.trigger} on ${SCENARIO.service}. Start by forming hypotheses, then use your tools to gather evidence.` },
  ];

  // Turn 1: hypothesize (free text, no tools yet)
  const hypoResult = await callAPI(modelName, messages, 'none');
  run.totalInputTokens += hypoResult.inputTokens;
  run.totalOutputTokens += hypoResult.outputTokens;
  run.totalReasoningTokens += hypoResult.reasoningTokens;

  messages.push({ role: 'assistant', content: hypoResult.content });
  messages.push({ role: 'user', content: 'Good. Now use your tools to gather evidence. You MUST call at least 3 different tools to investigate.' });

  // Turns 2-N: gather (enforce tool use)
  let gatherRounds = 0;
  while (gatherRounds < MAX_GATHER_ROUNDS) {
    const toolChoice = gatherRounds === 0 ? 'required' : 'auto';
    const turnResult = await callAPI(modelName, messages, toolChoice);
    run.totalInputTokens += turnResult.inputTokens;
    run.totalOutputTokens += turnResult.outputTokens;
    run.totalReasoningTokens += turnResult.reasoningTokens;
    gatherRounds++;

    if (turnResult.toolCalls.length === 0) {
      // Model stopped calling tools — done gathering
      if (turnResult.content) {
        messages.push({ role: 'assistant', content: turnResult.content });
      }
      break;
    }

    // Add assistant message with tool_calls
    messages.push({
      role: 'assistant',
      content: turnResult.content ?? null,
      tool_calls: turnResult.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });

    // Inject mock tool results
    for (const tc of turnResult.toolCalls) {
      run.totalToolCalls++;
      run.uniqueTools.add(tc.name);
      run.toolCallLog.push({ name: tc.name, args: tc.args });

      const mockResult = getMockToolResult(tc.name, tc.args);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: JSON.stringify(mockResult),
      });
    }
  }

  run.gatherRounds = gatherRounds;

  // Final turn: report (no tools)
  messages.push({ role: 'user', content: REPORT_PROMPT });
  const reportResult = await callAPI(modelName, messages, 'none');
  run.totalInputTokens += reportResult.inputTokens;
  run.totalOutputTokens += reportResult.outputTokens;
  run.totalReasoningTokens += reportResult.reasoningTokens;

  // Parse finding
  const rawContent = reportResult.content ?? '';
  const jsonMatch = rawContent.match(/\{[\s\S]+\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      run.finding = obj;
      run.findingValid =
        typeof obj.summary === 'string' &&
        typeof obj.rootCause === 'string' &&
        ['high', 'medium', 'low'].includes(obj.confidence as string) &&
        Array.isArray(obj.affectedServices) &&
        typeof obj.recommendation === 'string';
    } catch { /* invalid JSON */ }
  }

  return run;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------
interface BenchmarkResult {
  model: string;
  durationMs: number;
  totalToolCalls: number;
  uniqueToolsUsed: number;
  gatherRounds: number;
  findingValid: boolean;
  rootCause?: string;
  confidence?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('Proactive Investigation Agent — Tool Calling Benchmark', () => {
  jest.setTimeout(300_000);

  const results: BenchmarkResult[] = [];

  afterAll(() => {
    const W = { model: 28, time: 9, calls: 7, uniq: 6, rounds: 7, find: 6, inTok: 8, outTok: 8, reason: 8 };

    console.log('\n' + '='.repeat(140));
    console.log('PROACTIVE INVESTIGATION — TOOL CALLING BENCHMARK');
    console.log(`Scenario: ${SCENARIO.trigger}`);
    console.log(`Thinking: ${ENABLE_THINKING ? 'ON' : 'OFF'} | parallel_tool_calls: false | max gather rounds: ${MAX_GATHER_ROUNDS}`);
    console.log('='.repeat(140));
    console.log(
      [
        'Model'.padEnd(W.model),
        'Time(ms)'.padStart(W.time),
        'Calls'.padStart(W.calls),
        'Uniq'.padStart(W.uniq),
        'Rounds'.padStart(W.rounds),
        'Find'.padStart(W.find),
        'InTok'.padStart(W.inTok),
        'OutTok'.padStart(W.outTok),
        'Reason'.padStart(W.reason),
        'Root cause (truncated)',
      ].join(' | '),
    );
    console.log('-'.repeat(140));

    const sorted = [...results].sort((a, b) => {
      // Score: tool diversity (×4, cap 20) + finding valid (×30) + call count (×2, cap 10) - error (−50)
      const score = (r: BenchmarkResult) =>
        Math.min(r.uniqueToolsUsed * 4, 20) +
        (r.findingValid ? 30 : 0) +
        Math.min(r.totalToolCalls * 2, 10) -
        (r.error ? 50 : 0);

      return score(b) - score(a);
    });

    for (const r of sorted) {
      const rootSnip = r.error
        ? `ERROR: ${r.error.slice(0, 50)}`
        : r.rootCause?.slice(0, 60) ?? (r.findingValid ? '(valid)' : 'NO FINDING');
      console.log(
        [
          r.model.padEnd(W.model),
          String(r.durationMs).padStart(W.time),
          String(r.totalToolCalls).padStart(W.calls),
          String(r.uniqueToolsUsed).padStart(W.uniq),
          String(r.gatherRounds).padStart(W.rounds),
          (r.findingValid ? '✓' : '✗').padStart(W.find),
          String(r.totalInputTokens).padStart(W.inTok),
          String(r.totalOutputTokens).padStart(W.outTok),
          String(r.totalReasoningTokens).padStart(W.reason),
          rootSnip,
        ].join(' | '),
      );
    }

    console.log('='.repeat(140));
    console.log('\n📊 RANKED SUMMARY (tool diversity × 4 + finding × 30 + call breadth × 2):');
    console.log('');

    const medals = ['🥇', '🥈', '🥉'];
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      const score =
        Math.min(r.uniqueToolsUsed * 4, 20) +
        (r.findingValid ? 30 : 0) +
        Math.min(r.totalToolCalls * 2, 10);
      const m = medals[i] ?? `  ${i + 1}.`;
      console.log(
        `  ${m} ${r.model.padEnd(W.model)} ` +
        `score=${String(score).padStart(3)}  ` +
        `tools=${r.uniqueToolsUsed}/${TOOL_DEFINITIONS.length} unique  ` +
        `calls=${r.totalToolCalls}  ` +
        `rounds=${r.gatherRounds}  ` +
        `finding=${r.findingValid ? 'valid (' + r.confidence + ')' : 'MISSING'}  ` +
        `${r.durationMs}ms  in=${r.totalInputTokens} out=${r.totalOutputTokens}` +
        (r.totalReasoningTokens ? `  think=${r.totalReasoningTokens}` : ''),
      );
    }

    // Tool usage breakdown
    console.log('\n🔧 TOOL CALL LOG per model:');
    for (const r of sorted) {
      if (r.error) continue;
      const result = results.find(x => x.model === r.model);
      if (result) {
        console.log(`  ${r.model}: [${r.model}] calls=${r.totalToolCalls} unique=${r.uniqueToolsUsed}`);
      }
    }
    console.log('');
  });

  it.each(MODELS_TO_TEST)('benchmark %s', async modelName => {
    const result: BenchmarkResult = {
      model: modelName,
      durationMs: 0,
      totalToolCalls: 0,
      uniqueToolsUsed: 0,
      gatherRounds: 0,
      findingValid: false,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
    };

    const start = performance.now();

    try {
      const run = await runInvestigation(modelName);

      result.durationMs = Math.round(performance.now() - start);
      result.totalToolCalls = run.totalToolCalls;
      result.uniqueToolsUsed = run.uniqueTools.size;
      result.gatherRounds = run.gatherRounds;
      result.findingValid = run.findingValid;
      result.rootCause = run.finding?.rootCause as string | undefined;
      result.confidence = run.finding?.confidence as string | undefined;
      result.totalInputTokens = run.totalInputTokens;
      result.totalOutputTokens = run.totalOutputTokens;
      result.totalReasoningTokens = run.totalReasoningTokens;

      console.log(
        `\n[${modelName}] ${result.durationMs}ms | ` +
        `tools=${run.totalToolCalls} calls, ${run.uniqueTools.size} unique [${[...run.uniqueTools].join(', ')}] | ` +
        `finding=${run.findingValid ? 'valid' : 'MISSING'}`,
      );
      if (run.toolCallLog.length > 0) {
        run.toolCallLog.forEach((tc, i) => {
          console.log(`  call ${i + 1}: ${tc.name}(${JSON.stringify(tc.args).slice(0, 80)})`);
        });
      }
      if (run.finding?.rootCause) {
        console.log(`  rootCause: ${String(run.finding.rootCause).slice(0, 120)}`);
        console.log(`  confidence: ${run.finding.confidence}`);
      }
    } catch (err) {
      result.durationMs = Math.round(performance.now() - start);
      result.error = (err as Error).message?.slice(0, 100);
      console.warn(`[${modelName}] ERROR: ${result.error}`);
    }

    results.push(result);

    // Must have called at least 1 tool (tool calling enforced)
    if (!result.error) {
      expect(result.totalToolCalls).toBeGreaterThanOrEqual(1);
    } else {
      // Soft-fail on API errors
      expect(result.error).toBeUndefined();
    }
  });
});
