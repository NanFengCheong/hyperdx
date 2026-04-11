import opentelemetry, { Counter, Histogram, metrics } from '@opentelemetry/api';
import type { LanguageModel, ToolSet } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { performance } from 'perf_hooks';

import { CODE_VERSION } from '@/config';
import type {
  IInvestigationMessage,
  ILoopState,
  IThinkingEntry,
  IToolCallEntry,
  LoopPhase,
} from '@/models/investigation';
import type { BudgetSnapshot } from '@/utils/investigationEventBus';
import { investigationEventBus } from '@/utils/investigationEventBus';

import { getAIModel } from './ai';
import { createInvestigationTools } from './investigation-tools/tools';

// ---------------------------------------------------------------------------
// OTel primitives (inline, matching the tasks/tracer.ts + tasks/metrics.ts pattern)
// ---------------------------------------------------------------------------

const investigationTracer = opentelemetry.trace.getTracer(
  'hyperdx-investigation',
  CODE_VERSION,
);

const meter = metrics.getMeter('hyperdx-investigation');

const phaseDurationHistogram: Histogram = meter.createHistogram(
  'hyperdx.investigation.phase.duration',
  { description: 'Wall time for each investigation phase', unit: 'ms' },
);

const cycleDurationHistogram: Histogram = meter.createHistogram(
  'hyperdx.investigation.cycle.duration',
  { description: 'Wall time for a complete investigation cycle', unit: 'ms' },
);

const toolCallCounter: Counter = meter.createCounter(
  'hyperdx.investigation.tool_call',
  { description: 'Number of tool calls made during investigation' },
);

const cycleCompleteCounter: Counter = meter.createCounter(
  'hyperdx.investigation.cycle.complete',
  { description: 'Count of completed investigation cycles' },
);

const cycleFailureCounter: Counter = meter.createCounter(
  'hyperdx.investigation.cycle.failure',
  { description: 'Count of failed investigation cycles' },
);

const artifactsCreatedCounter: Counter = meter.createCounter(
  'hyperdx.investigation.artifacts.created',
  {
    description: 'Number of monitoring artifacts created during investigation',
  },
);

// ---------------------------------------------------------------------------

// EntryPoint type (matches the model's entryPoint discriminator)
export type EntryPoint = {
  type: 'trace' | 'alert' | 'standalone';
  traceId?: any;
  alertId?: any;
};

// ---------------------------------------------------------------------------
// System Prompt Builders
// ---------------------------------------------------------------------------

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

You have tools to query observability data and create monitoring artifacts:
- **searchTraces**: Find traces by service, time range, status, or duration
- **getTraceDetail**: Get the full span tree for a specific trace
- **searchLogs**: Search log entries by text, service, and severity
- **getMetrics**: Get time series metrics (error rate, latency, throughput)
- **findSimilarErrors**: Find historically similar error patterns
- **getServiceMap**: Get service dependency graph with error rates
- **getSessionReplay**: Get session replay data linked to a trace
- **createSavedSearch**: Create a saved search for recurring patterns
- **createDashboard**: Create a dashboard to visualize trends
- **createAlert**: Create an alert to monitor a discovered pattern
- **retrieveMemory**: Search past investigation findings
- **getBaselineMetrics**: Compare current metrics against historical baselines
- **getServiceHealthScore**: Get computed health scores for all services
- **getActiveAlerts**: See what alerts are currently firing

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

// ---------------------------------------------------------------------------
// Phase-specific system prompts
// ---------------------------------------------------------------------------

export function buildPlanSystemPrompt({
  schemaPrompt,
  triggerDescription,
  memoryContext,
}: {
  schemaPrompt: string;
  triggerDescription: string;
  memoryContext: string;
}) {
  return `You are the PLANNING phase of a structured investigation cycle.

## Context
${triggerDescription}

## Past Investigation Memory
${memoryContext}

## Database Schema
${schemaPrompt}

## Your Job
Produce a structured investigation plan:

1. **Hypotheses** — 2-4 specific hypotheses about what might be wrong, ordered by likelihood × impact
2. **Evidence Plan** — Which tools to call, in what order, to validate/refute each hypothesis
3. **Success Criteria** — What would confirm or rule out each hypothesis
4. **Abort Conditions** — When to stop investigating (e.g., "if all services show normal baselines, skip to summarize")

## Constraints
- Maximum 8 tool calls total for the execute phase
- Prioritize hypotheses by likelihood × impact
- If past investigations found the same pattern, note it — this may be a recurring issue
- If no anomalies are detected in the scan, recommend skipping directly to summarize

Format your response as a structured plan. Be specific about which services, time ranges, and metrics to check.`;
}

export function buildExecuteSystemPrompt({
  plan,
  schemaPrompt,
}: {
  plan: string;
  schemaPrompt: string;
}) {
  return `You are the EXECUTION phase of a structured investigation cycle.

## Investigation Plan
${plan}

## Database Schema
${schemaPrompt}

## Your Job
1. Execute the evidence plan by calling the appropriate tools
2. After each tool call, note whether the evidence supports, refutes, or is inconclusive for each hypothesis
3. If you find something unexpected, you may revise the plan — but explain why
4. Stop when: all hypotheses have sufficient evidence, OR you've used 8 tool calls

Format your response as:
- EVIDENCE: [tool_name] → [key finding] → [supports/refutes/inconclusive] for [hypothesis N]
- REVISED PLAN: [if applicable]
- READY FOR VERIFICATION: [yes/no + reason]

Be concise. Focus on recording evidence, not explaining what the tools do.`;
}

export function buildVerifySystemPrompt({
  evidenceLog,
  schemaPrompt,
}: {
  evidenceLog: string;
  schemaPrompt: string;
}) {
  return `You are the VERIFICATION phase. Someone else executed an investigation and reached conclusions.

## Evidence Log to Verify
${evidenceLog}

## Database Schema
${schemaPrompt}

## Your Job
For each finding in the evidence log, try to **disprove** it using independent data:

1. If the finding was based on logs, check traces — do they tell the same story?
2. If the finding was based on one service, check dependent services — is the problem upstream or downstream?
3. If the finding was based on a 1-hour window, check 3-hour and 24-hour windows — is this a spike or a trend?
4. If the finding cites a specific error, use findSimilarErrors — has this happened before? Was it resolved?

For each finding, produce a verdict:
- **CONFIRMED** — Independent evidence supports the finding
- **WEAKENED** — Some evidence contradicts or casts doubt
- **INCONCLUSIVE** — Not enough data to verify

If you find that a finding is WEAKENED, suggest what the correct conclusion might be.
Be skeptical. Your job is to catch false positives, not confirm them.`;
}

export function buildSummarizeSystemPrompt({
  plan,
  evidenceLog,
  verificationVerdicts,
  schemaPrompt,
}: {
  plan: string;
  evidenceLog: string;
  verificationVerdicts: string;
  schemaPrompt: string;
}) {
  return `You are the SUMMARIZATION phase. You have the full investigation record.

## Investigation Record
- Plan: ${plan}
- Evidence: ${evidenceLog}
- Verification: ${verificationVerdicts}

## Database Schema
${schemaPrompt}

## Your Job

1. **Executive Summary** — 2-3 sentences: what happened, what caused it, how confident are we
2. **Findings Table**:
   | Hypothesis | Evidence | Verdict | Confidence |
3. **Root Cause** — If confirmed, describe the root cause with evidence citations
4. **Timeline** — When did this start? When did it peak? Is it ongoing?
5. **Recommendations** — What should the team do? (actionable, specific)
6. **Monitoring Actions** — What artifacts should be created to catch this earlier next time?
   - Saved searches for the specific error pattern
   - Dashboard tiles visualizing the degraded metric
   - Alerts with thresholds based on the observed anomaly

## Confidence Levels
- HIGH: Multiple independent sources confirm, verification CONFIRMED
- MEDIUM: Single source confirms, verification INCONCLUSIVE
- LOW: Evidence is weak or verification WEAKENED

If confidence is LOW, explicitly say "I'm not confident in these findings" and suggest what additional data would help.

Use the createSavedSearch, createDashboard, and createAlert tools to set up monitoring for anything worth tracking ongoing.`;
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

export function convertMessagesToAIFormat(
  messages: IInvestigationMessage[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}

function getInvestigationModel(): LanguageModel {
  return getAIModel();
}

// ---------------------------------------------------------------------------
// Single-phase agent runner
// ---------------------------------------------------------------------------

interface PhaseResult {
  text: string;
  toolCallCount: number;
  toolCalls: { name: string; args: unknown; result: unknown }[];
}

export async function runAgentPhase({
  messages,
  systemPrompt,
  connection,
  teamId,
  userId,
  maxSteps = 10,
  phaseName = 'unknown',
  investigationId,
  callIndexOffset = 0,
  onTextDelta,
  onToolCall,
  onToolEvent,
}: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: string;
  connection: { host: string; username: string; password: string };
  teamId: string;
  userId: string;
  maxSteps?: number;
  phaseName?: string;
  investigationId?: string;
  callIndexOffset?: number;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: unknown, result: unknown) => void;
  onToolEvent?: (event: {
    callIndex: number;
    tool: string;
    args: unknown;
    result?: unknown;
    error?: string;
    durationMs: number;
  }) => void;
}): Promise<PhaseResult> {
  return investigationTracer.startActiveSpan(
    `investigation.${phaseName}`,
    async span => {
      span.setAttributes({
        'hyperdx.investigation.team.id': teamId,
        'hyperdx.investigation.phase': phaseName,
        'hyperdx.investigation.max_steps': maxSteps,
      });

      const start = performance.now();
      const model = getInvestigationModel();
      const tools = createInvestigationTools({
        connection,
        teamId,
        userId,
      }) as ToolSet;

      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        experimental_telemetry: { isEnabled: true },
      });

      let fullText = '';
      let toolCallCount = 0;
      const allToolCalls: { name: string; args: unknown; result: unknown }[] =
        [];
      // Track per-tool-call start times keyed by phase-local index
      const toolCallStartTimes = new Map<number, number>();
      // Phase-local call index (0-based within this phase)
      let phaseLocalCallIndex = 0;

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              fullText += part.text;
              onTextDelta?.(part.text);
              break;
            case 'tool-call': {
              const localIdx = phaseLocalCallIndex++;
              const globalIdx = callIndexOffset + localIdx;
              toolCallCount++;
              toolCallStartTimes.set(localIdx, performance.now());
              span.addEvent('tool_call', {
                'tool.name': part.toolName,
                'tool.args': JSON.stringify(part.input).slice(0, 500),
              });
              if (investigationId) {
                investigationEventBus.emitDebugEvent({
                  type: 'tool_call',
                  investigationId,
                  callIndex: globalIdx,
                  phase: phaseName,
                  tool: part.toolName,
                  args: part.input as Record<string, unknown>,
                  timestamp: Date.now(),
                });
              }
              break;
            }
            case 'tool-result': {
              // localIdx for result matches the call order (tool-result follows tool-call in sequence)
              const localIdx = allToolCalls.length;
              const globalIdx = callIndexOffset + localIdx;
              const startTime =
                toolCallStartTimes.get(localIdx) ?? performance.now();
              const durationMs = performance.now() - startTime;
              allToolCalls.push({
                name: part.toolName,
                args: part.input,
                result: part.output,
              });
              toolCallCounter.add(1, {
                'hyperdx.investigation.team.id': teamId,
                'hyperdx.investigation.tool.name': part.toolName,
                'hyperdx.investigation.phase': phaseName,
              });
              if (investigationId) {
                investigationEventBus.emitDebugEvent({
                  type: 'tool_result',
                  investigationId,
                  callIndex: globalIdx,
                  phase: phaseName,
                  tool: part.toolName,
                  result: part.output,
                  durationMs,
                  timestamp: Date.now(),
                });
              }
              onToolEvent?.({
                callIndex: globalIdx,
                tool: part.toolName,
                args: part.input,
                result: part.output,
                durationMs,
              });
              onToolCall?.(part.toolName, part.input, part.output);
              break;
            }
          }
        }

        span.setAttribute(
          'hyperdx.investigation.tool_call_count',
          toolCallCount,
        );
        span.setAttribute(
          'hyperdx.investigation.output_length',
          fullText.length,
        );

        return { text: fullText, toolCallCount, toolCalls: allToolCalls };
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: 2, // ERROR
          message: (err as Error).message,
        });
        throw err;
      } finally {
        const duration = performance.now() - start;
        span.setAttribute('hyperdx.investigation.phase.duration_ms', duration);
        phaseDurationHistogram.record(duration, {
          'hyperdx.investigation.phase': phaseName,
          'hyperdx.investigation.team.id': teamId,
        });
        span.end();
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Legacy single-shot agent (backward compatible)
// ---------------------------------------------------------------------------

export async function runInvestigationAgent({
  messages,
  systemPrompt,
  connection,
  teamId,
  userId,
  onTextDelta,
  onToolCall,
  onFinish,
}: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: string;
  connection: { host: string; username: string; password: string };
  teamId: string;
  userId: string;
  onTextDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, args: unknown, result: unknown) => void;
  onFinish?: (text: string) => void;
}) {
  const result = await runAgentPhase({
    messages,
    systemPrompt,
    connection,
    teamId,
    userId,
    maxSteps: 10,
    onTextDelta,
    onToolCall,
  });

  onFinish?.(result.text);

  return { text: result.text, toolCalls: result.toolCalls };
}

// ---------------------------------------------------------------------------
// Multi-phase investigation cycle orchestrator
// ---------------------------------------------------------------------------

export interface InvestigationCycleInput {
  triggerDescription: string;
  triggerType: 'health_scan' | 'alert' | 'trend_review' | 'standalone';
  schemaPrompt: string;
  memoryContext: string;
  connection: { host: string; username: string; password: string };
  teamId: string;
  userId: string;
  investigationId?: string;
  onPhaseUpdate?: (phase: LoopPhase, output: string) => void;
}

export interface InvestigationCycleResult {
  plan: string;
  evidence: string;
  verification: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  phaseHistory: ILoopState['phaseHistory'];
  toolCallLog: IToolCallEntry[];
  thinkingLog: IThinkingEntry[];
}

export async function runInvestigationCycle({
  triggerDescription,
  triggerType,
  schemaPrompt,
  memoryContext,
  connection,
  teamId,
  userId,
  investigationId,
  onPhaseUpdate,
}: InvestigationCycleInput): Promise<InvestigationCycleResult> {
  return investigationTracer.startActiveSpan(
    'investigation.cycle',
    async cycleSpan => {
      cycleSpan.setAttributes({
        'hyperdx.investigation.team.id': teamId,
        'hyperdx.investigation.trigger.type': triggerType,
        'hyperdx.investigation.trigger.description': triggerDescription,
      });

      const cycleStart = performance.now();
      const phaseHistory: ILoopState['phaseHistory'] = [];
      const toolCallLog: IToolCallEntry[] = [];
      const thinkingLog: IThinkingEntry[] = [];
      const TOTAL_BUDGET = 22; // plan(3) + execute(8) + verify(6) + summarize(5)
      let toolCallIndex = 0;

      try {
        // ----- Phase 1: PLAN -----
        const planPrompt = buildPlanSystemPrompt({
          schemaPrompt,
          triggerDescription,
          memoryContext,
        });

        const planMessages = [
          {
            role: 'user' as const,
            content: `Plan an investigation: ${triggerDescription}`,
          },
        ];

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_start',
            investigationId,
            phase: 'plan',
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
        }

        const planResult = await runAgentPhase({
          messages: planMessages,
          systemPrompt: planPrompt,
          connection,
          teamId,
          userId,
          maxSteps: 3,
          phaseName: 'plan',
          investigationId,
          callIndexOffset: toolCallIndex,
          onToolEvent: event => {
            toolCallLog.push({
              callIndex: event.callIndex,
              phase: 'plan',
              tool: event.tool,
              args: event.args as Record<string, unknown>,
              result: event.result,
              error: event.error,
              durationMs: event.durationMs,
            });
          },
        });

        toolCallIndex += planResult.toolCallCount;
        phaseHistory.push({
          phase: 'plan',
          input: triggerDescription,
          output: planResult.text,
          toolCalls: planResult.toolCallCount,
          completedAt: new Date(),
        });
        onPhaseUpdate?.('plan', planResult.text);
        phaseHistory[phaseHistory.length - 1].summaryText =
          planResult.text.slice(0, 200);
        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_end',
            investigationId,
            phase: 'plan',
            summaryText: planResult.text.slice(0, 200),
            toolCallCount: planResult.toolCallCount,
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
          const planThinking: IThinkingEntry = {
            phase: 'plan',
            tokenCount: Math.floor(planResult.text.length / 4),
            content: planResult.text,
          };
          thinkingLog.push(planThinking);
          investigationEventBus.emitDebugEvent({
            type: 'thinking',
            investigationId,
            phase: 'plan',
            tokenCount: planThinking.tokenCount,
            content: planThinking.content,
            timestamp: Date.now(),
          });
        }

        // ----- Phase 2: EXECUTE -----
        const executePrompt = buildExecuteSystemPrompt({
          plan: planResult.text,
          schemaPrompt,
        });

        const executeMessages = [
          {
            role: 'user' as const,
            content:
              'Execute the investigation plan. Call tools to gather evidence.',
          },
        ];

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_start',
            investigationId,
            phase: 'execute',
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
        }

        const executeResult = await runAgentPhase({
          messages: executeMessages,
          systemPrompt: executePrompt,
          connection,
          teamId,
          userId,
          maxSteps: 8,
          phaseName: 'execute',
          investigationId,
          callIndexOffset: toolCallIndex,
          onToolEvent: event => {
            toolCallLog.push({
              callIndex: event.callIndex,
              phase: 'execute',
              tool: event.tool,
              args: event.args as Record<string, unknown>,
              result: event.result,
              error: event.error,
              durationMs: event.durationMs,
            });
          },
        });

        toolCallIndex += executeResult.toolCallCount;
        phaseHistory.push({
          phase: 'execute',
          input: planResult.text,
          output: executeResult.text,
          toolCalls: executeResult.toolCallCount,
          completedAt: new Date(),
        });
        onPhaseUpdate?.('execute', executeResult.text);
        phaseHistory[phaseHistory.length - 1].summaryText =
          executeResult.text.slice(0, 200);
        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_end',
            investigationId,
            phase: 'execute',
            summaryText: executeResult.text.slice(0, 200),
            toolCallCount: executeResult.toolCallCount,
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
          const executeThinking: IThinkingEntry = {
            phase: 'execute',
            tokenCount: Math.floor(executeResult.text.length / 4),
            content: executeResult.text,
          };
          thinkingLog.push(executeThinking);
          investigationEventBus.emitDebugEvent({
            type: 'thinking',
            investigationId,
            phase: 'execute',
            tokenCount: executeThinking.tokenCount,
            content: executeThinking.content,
            timestamp: Date.now(),
          });
        }

        // ----- Phase 3: VERIFY -----
        const verifyPrompt = buildVerifySystemPrompt({
          evidenceLog: executeResult.text,
          schemaPrompt,
        });

        const verifyMessages = [
          {
            role: 'user' as const,
            content:
              'Verify the investigation findings. Try to disprove each conclusion using independent data.',
          },
        ];

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_start',
            investigationId,
            phase: 'verify',
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
        }

        const verifyResult = await runAgentPhase({
          messages: verifyMessages,
          systemPrompt: verifyPrompt,
          connection,
          teamId,
          userId,
          maxSteps: 6,
          phaseName: 'verify',
          investigationId,
          callIndexOffset: toolCallIndex,
          onToolEvent: event => {
            toolCallLog.push({
              callIndex: event.callIndex,
              phase: 'verify',
              tool: event.tool,
              args: event.args as Record<string, unknown>,
              result: event.result,
              error: event.error,
              durationMs: event.durationMs,
            });
          },
        });

        toolCallIndex += verifyResult.toolCallCount;
        phaseHistory.push({
          phase: 'verify',
          input: executeResult.text,
          output: verifyResult.text,
          toolCalls: verifyResult.toolCallCount,
          completedAt: new Date(),
        });
        onPhaseUpdate?.('verify', verifyResult.text);
        phaseHistory[phaseHistory.length - 1].summaryText =
          verifyResult.text.slice(0, 200);
        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_end',
            investigationId,
            phase: 'verify',
            summaryText: verifyResult.text.slice(0, 200),
            toolCallCount: verifyResult.toolCallCount,
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
          const verifyThinking: IThinkingEntry = {
            phase: 'verify',
            tokenCount: Math.floor(verifyResult.text.length / 4),
            content: verifyResult.text,
          };
          thinkingLog.push(verifyThinking);
          investigationEventBus.emitDebugEvent({
            type: 'thinking',
            investigationId,
            phase: 'verify',
            tokenCount: verifyThinking.tokenCount,
            content: verifyThinking.content,
            timestamp: Date.now(),
          });
        }

        // ----- Phase 4: SUMMARIZE -----
        const summarizePrompt = buildSummarizeSystemPrompt({
          plan: planResult.text,
          evidenceLog: executeResult.text,
          verificationVerdicts: verifyResult.text,
          schemaPrompt,
        });

        const summarizeMessages = [
          {
            role: 'user' as const,
            content:
              'Synthesize the investigation findings into a structured report. Create monitoring artifacts for anything worth tracking ongoing.',
          },
        ];

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_start',
            investigationId,
            phase: 'summarize',
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
        }

        const summarizeResult = await runAgentPhase({
          messages: summarizeMessages,
          systemPrompt: summarizePrompt,
          connection,
          teamId,
          userId,
          maxSteps: 5,
          phaseName: 'summarize',
          investigationId,
          callIndexOffset: toolCallIndex,
          onToolEvent: event => {
            toolCallLog.push({
              callIndex: event.callIndex,
              phase: 'summarize',
              tool: event.tool,
              args: event.args as Record<string, unknown>,
              result: event.result,
              error: event.error,
              durationMs: event.durationMs,
            });
          },
        });

        toolCallIndex += summarizeResult.toolCallCount;
        phaseHistory.push({
          phase: 'summarize',
          input: verifyResult.text,
          output: summarizeResult.text,
          toolCalls: summarizeResult.toolCallCount,
          completedAt: new Date(),
        });
        onPhaseUpdate?.('summarize', summarizeResult.text);
        phaseHistory[phaseHistory.length - 1].summaryText =
          summarizeResult.text.slice(0, 200);
        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_end',
            investigationId,
            phase: 'summarize',
            summaryText: summarizeResult.text.slice(0, 200),
            toolCallCount: summarizeResult.toolCallCount,
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
          const summarizeThinking: IThinkingEntry = {
            phase: 'summarize',
            tokenCount: Math.floor(summarizeResult.text.length / 4),
            content: summarizeResult.text,
          };
          thinkingLog.push(summarizeThinking);
          investigationEventBus.emitDebugEvent({
            type: 'thinking',
            investigationId,
            phase: 'summarize',
            tokenCount: summarizeThinking.tokenCount,
            content: summarizeThinking.content,
            timestamp: Date.now(),
          });
        }

        // Determine confidence from verification verdicts
        const confidence = determineConfidence(verifyResult.text);

        // Extract artifact count from summary
        const artifactCount = countArtifactsInSummary(summarizeResult.text);

        // Record cycle-level metrics
        const cycleDuration = performance.now() - cycleStart;
        cycleDurationHistogram.record(cycleDuration, {
          'hyperdx.investigation.team.id': teamId,
          'hyperdx.investigation.trigger.type': triggerType,
          'hyperdx.investigation.confidence': confidence,
        });

        cycleCompleteCounter.add(1, {
          'hyperdx.investigation.team.id': teamId,
          'hyperdx.investigation.trigger.type': triggerType,
          'hyperdx.investigation.confidence': confidence,
        });

        // Record artifact creation counts
        for (const [type, count] of Object.entries(artifactCount)) {
          if (count > 0) {
            artifactsCreatedCounter.add(count, {
              'hyperdx.investigation.team.id': teamId,
              'hyperdx.investigation.artifact.type': type,
            });
          }
        }

        // Set cycle span attributes
        cycleSpan.setAttributes({
          'hyperdx.investigation.confidence': confidence,
          'hyperdx.investigation.cycle.duration_ms': cycleDuration,
          'hyperdx.investigation.plan.tool_calls': planResult.toolCallCount,
          'hyperdx.investigation.execute.tool_calls':
            executeResult.toolCallCount,
          'hyperdx.investigation.verify.tool_calls': verifyResult.toolCallCount,
          'hyperdx.investigation.summarize.tool_calls':
            summarizeResult.toolCallCount,
          'hyperdx.investigation.artifacts.created': Object.values(
            artifactCount,
          ).reduce((a, b) => a + b, 0),
        });

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'investigation_complete',
            investigationId,
            confidence,
            timestamp: Date.now(),
          });
        }

        return {
          plan: planResult.text,
          evidence: executeResult.text,
          verification: verifyResult.text,
          summary: summarizeResult.text,
          confidence,
          phaseHistory,
          toolCallLog,
          thinkingLog,
        };
      } catch (err) {
        cycleSpan.recordException(err as Error);
        cycleSpan.setStatus({
          code: 2, // ERROR
          message: (err as Error).message,
        });
        cycleFailureCounter.add(1, {
          'hyperdx.investigation.team.id': teamId,
          'hyperdx.investigation.trigger.type': triggerType,
        });
        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'investigation_failed',
            investigationId,
            error: (err as Error).message,
            timestamp: Date.now(),
          });
        }
        throw err;
      } finally {
        cycleSpan.end();
      }
    },
  );
}

/**
 * Extract confidence level from verification output.
 * Heuristic: look for CONFIRMED/WEAKENED/INCONCLUSIVE keywords.
 */
function determineConfidence(
  verificationText: string,
): 'high' | 'medium' | 'low' {
  const lower = verificationText.toLowerCase();
  const confirmedCount = (lower.match(/confirmed/g) || []).length;
  const weakenedCount = (lower.match(/weakened/g) || []).length;
  const inconclusiveCount = (lower.match(/inconclusive/g) || []).length;

  if (weakenedCount > 0) return 'low';
  if (inconclusiveCount > confirmedCount) return 'medium';
  if (confirmedCount >= 2 && weakenedCount === 0) return 'high';
  return 'medium';
}

/**
 * Count artifacts created in the summary by type.
 * Parses patterns like "created saved search: X (ID: Y)".
 */
function countArtifactsInSummary(summary: string): Record<string, number> {
  const counts: Record<string, number> = {
    savedSearch: 0,
    dashboard: 0,
    alert: 0,
  };

  const savedSearchPattern =
    /created (?:saved search|advanced dashboard):\s*[^(]*\(ID:\s*[a-f0-9]+\)/gi;
  const dashboardPattern =
    /created (?:advanced )?dashboard:\s*[^(]*\(ID:\s*[a-f0-9]+\)/gi;
  const alertPattern = /created alert:\s*[^(]*\(ID:\s*[a-f0-9]+\)/gi;

  for (const _match of summary.matchAll(savedSearchPattern)) {
    counts.savedSearch++;
  }
  for (const _match of summary.matchAll(dashboardPattern)) {
    counts.dashboard++;
  }
  for (const _match of summary.matchAll(alertPattern)) {
    counts.alert++;
  }

  return counts;
}
