import opentelemetry, { Counter, Histogram, metrics } from '@opentelemetry/api';
import type { LanguageModel, ModelMessage, ToolSet } from 'ai';
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
  type: 'trace' | 'alert' | 'standalone' | 'proactive';
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
  return `## Role
You are the PLANNING skill of the HyperDX investigation pipeline.
Produce a structured investigation plan that the EXECUTION skill will follow.

## Inputs
- Trigger: ${triggerDescription}
- Past investigation memory: ${memoryContext}
- Database schema: ${schemaPrompt}

## Tools
- **retrieveMemory**: Search past investigation findings for this service/pattern
- **getActiveAlerts**: See what alerts are currently firing across all services
- **getServiceHealthScore**: Get computed health scores — if all services are green, emit NO_ANOMALY
- **getServiceMap**: Get service dependency graph to understand blast radius

## Task
1. Call getActiveAlerts and getServiceHealthScore to assess current state
2. Call retrieveMemory to check for prior incidents matching this trigger
3. If all services show normal health AND no matching alerts fire, output exactly: NO_ANOMALY
4. Otherwise, produce a structured investigation plan:

## Output Format
Output a JSON block (fenced with \`\`\`json) with this exact schema:
\`\`\`json
{
  "hypotheses": [
    { "id": 1, "description": "...", "likelihood": "high|medium|low", "impact": "high|medium|low" }
  ],
  "evidencePlan": [
    { "hypothesisId": 1, "tool": "searchLogs", "args": { "service": "...", "query": "...", "timeRange": "Past 30m" }, "expectedFinding": "..." }
  ],
  "successCriteria": ["..."],
  "abortIf": "..."
}
\`\`\`

## Constraints
- Maximum 8 tool calls in the execute phase — prioritise hypotheses by likelihood × impact
- If past investigations found the same pattern, note it — this may be a recurring issue

## Abort Conditions
- If getServiceHealthScore shows all green AND getActiveAlerts returns empty: output NO_ANOMALY and stop`;
}

export function buildExecuteSystemPrompt({
  plan,
  schemaPrompt,
}: {
  plan: string;
  schemaPrompt: string;
}) {
  return `## Role
You are the EXECUTION skill of the HyperDX investigation pipeline.
Execute the evidence plan by calling tools sequentially and recording findings.

## Inputs
- Investigation plan: ${plan}
- Database schema: ${schemaPrompt}

## Tools
- **searchTraces**: Find slow/failed traces to confirm a hypothesis. Use to measure scope and identify root spans.
- **searchLogs**: Find error/warn log patterns to build evidence for each hypothesis. Search for the specific error messages the hypothesis predicts.
- **getMetrics**: Get time-series data to measure the anomaly's scope and timing. Check error_rate, latency_p99, throughput.
- **findSimilarErrors**: Find historically similar error patterns. Use after finding a specific error to check recurrence.
- **getBaselineMetrics**: Compare current metrics against historical baselines. Use to quantify how anomalous the current state is.
- **getServiceMap**: Get service dependency graph. Use to check if the problem is upstream or downstream of the reported service.

## Task
1. Work through the evidencePlan from the plan, one tool call at a time
2. After each tool result, record the finding before deciding the next call
3. Call tools **sequentially** — analyse each result before calling the next
4. Stop when: all hypotheses have sufficient evidence OR you have used 8 tool calls

## Output Format
After each tool call, append a line:
EVIDENCE: [tool_name] → [key finding in ≤20 words] → [supports/refutes/inconclusive] Hypothesis [N]

End with a SUMMARY block:
SUMMARY: [1-2 sentences on strongest supported hypothesis and confidence]

## Success Criteria
Every hypothesis in the plan has at least one EVIDENCE line

## Abort Conditions
If the plan's abortIf condition is met (e.g. all baselines normal), stop and output:
ABORT: [condition met] — proceeding to summarize with low confidence`;
}

export function buildVerifySystemPrompt({
  schemaPrompt,
}: {
  schemaPrompt: string;
}) {
  return `## Role
You are the VERIFICATION skill of the HyperDX investigation pipeline.
Your job is to independently cross-check the execute phase's findings by trying to disprove them.

## Inputs
The full execute phase conversation is in your message history — you can see every tool call, result, and EVIDENCE line directly.
- Database schema: ${schemaPrompt}

## Tools
- **searchTraces**: Check traces the execute phase did NOT check — test whether the problem is upstream or downstream of the reported service.
- **searchLogs**: Independently verify a finding — search for the same pattern from a different angle, or look for contradicting evidence.
- **getMetrics**: Check a wider time window (3h/24h) than execute used — distinguish spike vs trend. Do not repeat execute's exact time range.
- **findSimilarErrors**: Check if the reported error has occurred before at a different time — test whether this is a recurring pattern.

## Task
1. For each EVIDENCE line in the execute output, assess: can I disprove this?
2. Call tools using **independent angles** — do not repeat any query the execute phase already made with the same arguments
3. After each tool result, produce a VERDICT line
4. Stop when all execute EVIDENCE lines have a VERDICT

## Output Format
For each finding:
VERDICT: [CONFIRMED|WEAKENED|INCONCLUSIVE] — [reason in ≤20 words] — [tool used as evidence]

End with:
OVERALL: [CONFIRMED|WEAKENED|INCONCLUSIVE] — [1 sentence]

## Constraints
Do not repeat any tool call the execute phase already made with the same arguments.
Use independent angles: different time windows, different services, different signal types.

## Success Criteria
Every EVIDENCE line from execute has a corresponding VERDICT`;
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
  return `## Role
You are the SUMMARIZATION skill of the HyperDX investigation pipeline.
Synthesize all findings into a structured report and create monitoring artifacts.

## Inputs
- Plan: ${plan}
- Evidence: ${evidenceLog}
- Verification verdicts: ${verificationVerdicts}
- Database schema: ${schemaPrompt}

## Tools
- **createSavedSearch**: Create a saved search for a specific error pattern worth monitoring. Only create if confidence is medium or high.
- **createDashboard**: Create a dashboard to visualise a degraded metric. Only create if confidence is medium or high.
- **createAlert**: Create an alert with thresholds based on the observed anomaly. Only create if confidence is medium or high.

## Task
1. Determine confidence level:
   - HIGH: ≥2 CONFIRMED verdicts, 0 WEAKENED
   - MEDIUM: ≥1 CONFIRMED, INCONCLUSIVE allowed
   - LOW: any WEAKENED verdict present
2. Produce the structured report (see Output Format)
3. If confidence is medium or high: call createSavedSearch/createDashboard/createAlert for patterns worth tracking
4. If confidence is LOW: add disclaimer "I'm not confident in these findings" and skip artifact creation

## Output Format
### Executive Summary
[2-3 sentences: what happened, root cause, confidence level]

### Findings
| Hypothesis | Evidence | Verdict | Confidence |
|------------|----------|---------|------------|

### Root Cause
[If CONFIRMED: specific technical root cause with evidence citations]
[If LOW confidence: "Insufficient evidence — recommend investigating: [X]"]

### Timeline
[When did this start? When did it peak? Is it ongoing?]

### Recommendations
[2-3 specific, actionable items]

### Monitoring Artifacts Created
[List any saved searches, dashboards, alerts created — or "None (low confidence)"]

## Confidence Levels
- HIGH: Multiple independent sources confirm, verification CONFIRMED
- MEDIUM: Single source confirms, verification INCONCLUSIVE
- LOW: Any WEAKENED verdict — output: "I'm not confident in these findings. Additional data needed: [X]"]`;
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
  outputMessages: ModelMessage[];
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
  forceFirstStep = false,
  onTextDelta,
  onToolCall,
  onToolEvent,
}: {
  messages: ModelMessage[];
  systemPrompt: string;
  connection: { host: string; username: string; password: string };
  teamId: string;
  userId: string;
  maxSteps?: number;
  phaseName?: string;
  investigationId?: string;
  callIndexOffset?: number;
  forceFirstStep?: boolean;
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
      const validPhases = ['plan', 'execute', 'verify', 'summarize'] as const;
      const phase = validPhases.includes(phaseName as any)
        ? (phaseName as 'plan' | 'execute' | 'verify' | 'summarize')
        : undefined;
      const tools = createInvestigationTools({
        connection,
        teamId,
        userId,
        phase,
      }) as ToolSet;

      const result = streamText({
        model,
        system: systemPrompt,
        messages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        ...(forceFirstStep ? { toolChoice: 'required' } : {}),
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

        const responseMessages = await result.response;
        const outputMessages: ModelMessage[] = [
          ...messages,
          ...(responseMessages.messages ?? []),
        ];

        return {
          text: fullText,
          toolCallCount,
          toolCalls: allToolCalls,
          outputMessages,
        };
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
  messages: ModelMessage[];
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

      // Helper: runs a single phase with full event-bus tracking, history,
      // thinking-log, and tool-call-log bookkeeping.  Mutates the closure
      // arrays in place and returns the PhaseResult + updated toolCallIndex.
      async function runPhaseWithTracking({
        phaseName,
        prompt,
        messages: phaseMessages,
        maxSteps,
        phaseInput,
        forceFirstStep,
      }: {
        phaseName: LoopPhase;
        prompt: string;
        messages: ModelMessage[];
        maxSteps: number;
        phaseInput: string;
        forceFirstStep?: boolean;
      }): Promise<{ result: PhaseResult; newToolCallIndex: number }> {
        const remainingBudget = TOTAL_BUDGET - toolCallIndex;
        if (remainingBudget <= 0) {
          const skipped: PhaseResult = {
            text: `SKIPPED: Budget exhausted before ${phaseName} phase.`,
            toolCallCount: 0,
            toolCalls: [],
            outputMessages: phaseMessages,
          };
          phaseHistory.push({
            phase: phaseName,
            input: phaseInput,
            output: skipped.text,
            toolCalls: 0,
            completedAt: new Date(),
          });
          onPhaseUpdate?.(phaseName, skipped.text);
          return { result: skipped, newToolCallIndex: toolCallIndex };
        }
        const cappedMaxSteps = Math.min(maxSteps, remainingBudget);

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_start',
            investigationId,
            phase: phaseName,
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
        }

        const result = await runAgentPhase({
          messages: phaseMessages,
          systemPrompt: prompt,
          connection,
          teamId,
          userId,
          maxSteps: cappedMaxSteps,
          phaseName,
          investigationId,
          callIndexOffset: toolCallIndex,
          forceFirstStep,
          onToolEvent: event => {
            toolCallLog.push({
              callIndex: event.callIndex,
              phase: phaseName,
              tool: event.tool,
              args: event.args as Record<string, unknown>,
              result: event.result,
              error: event.error,
              durationMs: event.durationMs,
            });
          },
        });

        toolCallIndex += result.toolCallCount;
        phaseHistory.push({
          phase: phaseName,
          input: phaseInput,
          output: result.text,
          toolCalls: result.toolCallCount,
          completedAt: new Date(),
        });
        onPhaseUpdate?.(phaseName, result.text);
        phaseHistory[phaseHistory.length - 1].summaryText =
          result.text.slice(0, 200);

        if (investigationId) {
          investigationEventBus.emitDebugEvent({
            type: 'phase_end',
            investigationId,
            phase: phaseName,
            summaryText: result.text.slice(0, 200),
            toolCallCount: result.toolCallCount,
            budgetSnapshot: {
              toolCallsUsed: toolCallIndex,
              toolCallsTotal: TOTAL_BUDGET,
            },
            timestamp: Date.now(),
          });
          const thinking: IThinkingEntry = {
            phase: phaseName,
            tokenCount: Math.floor(result.text.length / 4),
            content: result.text,
          };
          thinkingLog.push(thinking);
          investigationEventBus.emitDebugEvent({
            type: 'thinking',
            investigationId,
            phase: phaseName,
            tokenCount: thinking.tokenCount,
            content: thinking.content,
            timestamp: Date.now(),
          });
        }

        return { result, newToolCallIndex: toolCallIndex };
      }

      try {
        // ----- Phase 1: PLAN -----
        const planPrompt = buildPlanSystemPrompt({
          schemaPrompt,
          triggerDescription,
          memoryContext,
        });

        const { result: planResult } = await runPhaseWithTracking({
          phaseName: 'plan',
          prompt: planPrompt,
          messages: [
            {
              role: 'user' as const,
              content: `Plan an investigation: ${triggerDescription}`,
            },
          ],
          maxSteps: 3,
          phaseInput: triggerDescription,
        });

        // Check for NO_ANOMALY — skip remaining phases
        if (planResult.text.includes('NO_ANOMALY')) {
          const cycleDuration = performance.now() - cycleStart;
          cycleDurationHistogram.record(cycleDuration, {
            'hyperdx.investigation.team.id': teamId,
            'hyperdx.investigation.trigger.type': triggerType,
            'hyperdx.investigation.confidence': 'low',
          });
          cycleCompleteCounter.add(1, {
            'hyperdx.investigation.team.id': teamId,
            'hyperdx.investigation.trigger.type': triggerType,
            'hyperdx.investigation.confidence': 'low',
          });

          if (investigationId) {
            investigationEventBus.emitDebugEvent({
              type: 'investigation_complete',
              investigationId,
              confidence: 'low',
              timestamp: Date.now(),
            });
          }

          return {
            plan: planResult.text,
            evidence: '',
            verification: '',
            summary:
              'NO_ANOMALY: All services healthy, no active alerts. No investigation needed.',
            confidence: 'low' as const,
            phaseHistory,
            toolCallLog,
            thinkingLog,
          };
        }

        // ----- Phase 2: EXECUTE -----
        const executePrompt = buildExecuteSystemPrompt({
          plan: planResult.text,
          schemaPrompt,
        });

        const { result: executeResult } = await runPhaseWithTracking({
          phaseName: 'execute',
          prompt: executePrompt,
          messages: [
            {
              role: 'user' as const,
              content:
                'Execute the investigation plan. Call tools to gather evidence.',
            },
          ],
          maxSteps: 8,
          phaseInput: planResult.text,
          forceFirstStep: true,
        });

        // ----- Phase 3: VERIFY -----
        const verifyPrompt = buildVerifySystemPrompt({
          schemaPrompt,
        });

        const { result: verifyResult } = await runPhaseWithTracking({
          phaseName: 'verify',
          prompt: verifyPrompt,
          messages: [
            ...executeResult.outputMessages,
            {
              role: 'user' as const,
              content:
                'Verify the investigation findings. Try to disprove each conclusion using independent data.',
            },
          ],
          maxSteps: 6,
          phaseInput: executeResult.text,
          forceFirstStep: true,
        });

        // ----- Phase 4: SUMMARIZE -----
        const summarizePrompt = buildSummarizeSystemPrompt({
          plan: planResult.text,
          evidenceLog: executeResult.text,
          verificationVerdicts: verifyResult.text,
          schemaPrompt,
        });

        const { result: summarizeResult } = await runPhaseWithTracking({
          phaseName: 'summarize',
          prompt: summarizePrompt,
          messages: [
            {
              role: 'user' as const,
              content:
                'Synthesize the investigation findings into a structured report. Create monitoring artifacts for anything worth tracking ongoing.',
            },
          ],
          maxSteps: 5,
          phaseInput: verifyResult.text,
        });

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
  if (confirmedCount >= 2) return 'high';
  return 'medium';
}

/**
 * Count artifacts created in the summary by type.
 * Parses patterns like "created saved search: X (ID: Y)".
 */
export function countArtifactsInSummary(summary: string): Record<string, number> {
  const counts: Record<string, number> = {
    savedSearch: 0,
    dashboard: 0,
    alert: 0,
  };

  const savedSearchPattern =
    /created saved search:\s*[^(]*\(ID:\s*[a-f0-9]+\)/gi;
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
