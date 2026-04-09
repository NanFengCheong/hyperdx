import type { LanguageModel } from 'ai';
import { stepCountIs, streamText } from 'ai';

import type { IInvestigationMessage } from '@/models/investigation';

import { getAIModel } from './ai';
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
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));
}

function getInvestigationModel(): LanguageModel {
  return getAIModel();
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
  const model = getInvestigationModel();
  const tools = createInvestigationTools(connection);

  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(10),
    experimental_telemetry: { isEnabled: true },
  });

  let fullText = '';
  const allToolCalls: { name: string; args: unknown; result: unknown }[] = [];

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        fullText += part.text;
        onTextDelta?.(part.text);
        break;
      case 'tool-call':
        // Will be handled by tool-result for the result
        break;
      case 'tool-result':
        allToolCalls.push({
          name: part.toolName,
          args: part.input,
          result: part.output,
        });
        onToolCall?.(part.toolName, part.input, part.output);
        break;
    }
  }

  onFinish?.(fullText);

  return { text: fullText, toolCalls: allToolCalls };
}
