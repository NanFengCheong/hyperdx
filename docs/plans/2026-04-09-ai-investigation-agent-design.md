# AI Investigation Agent — Design Document

**Date:** 2026-04-09
**Status:** Approved

## Problem

HyperDX users investigating production incidents must manually correlate
traces, logs, metrics, and session replays across multiple views. The existing
AI integration is limited to single-turn chart generation. There is no
conversational investigation workflow, no root cause analysis assistance, and no
structured incident report generation.

## Solution

A multi-turn AI investigation agent that uses tool-calling to query
observability data, progressively build context, and generate incident reports.

## Key Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| AI pattern | Server-side agent with tool-use | Secure (no client-side API keys), direct DB access, supports background alert investigations |
| Tools | 7 named tools, schema-aware | Named tools give well-formatted output; ClickHouse schema injected into system prompt for field awareness |
| Entry points | Trace panel, alert (semi-auto), standalone page | Covers reactive debugging, alert response, and proactive investigation |
| UI | Side panel + full page | Side panel for quick questions, full page for deep investigations |
| Persistence | MongoDB `investigations` collection | Messages inline, audit trail of tool calls preserved |
| Sharing | Team-scoped, link + explicit member sharing | Aligns with existing RBAC; read-only group members can view but not message |
| Export | AI-generated markdown incident report | Deliverable to Slack/webhook, attachable to alert history |
| Streaming | SSE from server agent loop | Real-time response delivery |
| AI providers | Anthropic + OpenAI via Vercel `ai` SDK | Extends existing provider support |

## Data Model

MongoDB collection: `investigations`

```json
{
  "_id": "ObjectId",
  "teamId": "ObjectId",
  "createdBy": "ObjectId",
  "title": "string",
  "status": "active | resolved | exported",
  "entryPoint": {
    "type": "trace | alert | standalone",
    "traceId": "string (optional)",
    "alertId": "ObjectId (optional)"
  },
  "messages": [
    {
      "role": "user | assistant | tool",
      "content": "string",
      "toolCalls": [{"name": "string", "args": {}, "result": {}}],
      "timestamp": "Date"
    }
  ],
  "summary": "string",
  "sharedWith": ["ObjectId"],
  "exports": [
    {
      "format": "markdown | json",
      "content": "string",
      "createdAt": "Date"
    }
  ],
  "createdAt": "Date",
  "updatedAt": "Date"
}
```

Messages stored inline (investigations rarely exceed hundreds of messages).
`toolCalls` embedded in assistant messages for audit trail. `summary` updated
periodically for list views.

## API Endpoints

All under `/api/v1/investigations`, team-scoped via Passport.js auth.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/investigations` | Create investigation (optional entryPoint context) |
| GET | `/investigations` | List investigations (paginated, team-scoped) |
| GET | `/investigations/:id` | Get full investigation with messages |
| POST | `/investigations/:id/messages` | Send message, trigger agent loop, SSE stream response |
| PATCH | `/investigations/:id` | Update title, status, sharing |
| DELETE | `/investigations/:id` | Soft delete |
| POST | `/investigations/:id/export` | Generate incident report |
| POST | `/investigations/:id/share` | Share with team members |

### Core Message Flow

```
1. Client sends user message
2. Server appends to investigation.messages
3. Server calls AI provider with:
   - System prompt (investigation context, available tools, ClickHouse schema)
   - Full message history
   - Tool definitions
4. AI responds — may include tool calls
5. Server executes tool calls (ClickHouse/MongoDB queries)
6. Server feeds tool results back to AI
7. Repeat 4-6 until AI produces final text response
8. Stream final response via SSE
9. Persist all messages to MongoDB
```

### Semi-Auto Alert Entry Point

`POST /investigations` with `entryPoint.type: "alert"` triggers an automatic
first turn. Server injects a system-generated message ("Investigate this alert:
[alert details]") and runs the agent loop before returning. AI auto-executes
2-3 initial tool calls (fetch triggering trace, surrounding logs, recent error
rate) and presents an initial summary.

## AI Tools

Seven named tools. Each executes server-side against ClickHouse/MongoDB with
automatic team scoping.

### Schema Awareness

On investigation start, server runs `SHOW TABLES` + `DESCRIBE TABLE` against
ClickHouse. Schema summary injected into system prompt:

```
Available tables and fields:
- default.otel_traces: traceId, spanId, serviceName, duration, statusCode, ...
- default.otel_logs: timestamp, body, severityText, serviceName, ...
- default.otel_metrics: metricName, value, timestamp, ...
```

Named tools accept an optional `fields` param to select/filter on any known
column.

### Tool Definitions

| Tool | Input | Queries | Returns |
|------|-------|---------|---------|
| searchTraces | `{service?, timeRange, status?, minDuration?, query?, fields?}` | ClickHouse traces | Top 20 traces (traceId, service, duration, status, timestamp) |
| getTraceDetail | `{traceId}` | ClickHouse spans | Full span tree with timing, attributes, events, errors |
| searchLogs | `{query, timeRange, service?, level?, fields?}` | ClickHouse logs | Top 50 log lines with timestamps and attributes |
| getMetrics | `{service, metric, timeRange, granularity?}` | ClickHouse metrics | Time series (error rate, latency p50/p95/p99, throughput) |
| findSimilarErrors | `{errorMessage, service?, timeRange?}` | ClickHouse traces + logs | Matching traces/logs grouped by pattern with frequency |
| getServiceMap | `{service?, timeRange}` | ClickHouse spans | Upstream/downstream services with edge latency and error rates |
| getSessionReplay | `{traceId or sessionId}` | MongoDB sessions + ClickHouse | Session metadata, events timeline, linked trace IDs |

Tool results are truncated/summarized before feeding to AI. `timeRange`
defaults to +/-30min around the anchor trace if not specified.

### System Prompt

Instructs the AI to:
- Investigate the incident using available tools
- Cite specific traces/logs as evidence for conclusions
- Synthesize findings into incident reports when asked
- Be aware of all available ClickHouse tables and fields

## Frontend Components

### Side Panel (`InvestigationSidePanel.tsx`)

- Slides in from right (same pattern as `DBTracePanel`)
- Triggered by "Investigate" button on trace detail or alert detail
- Chat interface: message list + input box
- Pre-populates context from entry point
- "Expand" button navigates to full page with same investigation

### Full Page (`/investigations` and `/investigations/:id`)

- **List view:** Team investigations with title, status, creator, date
- **Detail view:** Wide chat panel + left sidebar (entry point, linked traces, status)
- "New Investigation" button for standalone entry
- "Export" button for incident report generation

### Shared Components

- `InvestigationChat.tsx` — core chat, used by side panel and full page
- `InvestigationMessage.tsx` — renders user text, assistant markdown, tool call summaries
- `InvestigationExport.tsx` — export/share modal

## Export & Sharing

### Export

- **Markdown:** AI-generated incident report with sections: Summary, Timeline,
  Root Cause, Affected Services, Evidence (linked traces/logs), Recommendations
- **JSON:** Raw investigation data for programmatic use
- Flow: User clicks Export → server prompts AI to synthesize → stored in
  `investigation.exports[]` → copy/download/send to Slack/webhook

### Sharing

- **Link sharing:** Team members with link can view (read-only)
- **Explicit sharing:** Add members who can also send messages
- **RBAC:** `read-only` group members can view but not message
- Exported reports auto-attachable to originating alert history

## Build Order

1. Data model + API endpoints (CRUD + message endpoint with agent loop)
2. Tool implementations (wrappers around existing ClickHouse/MongoDB queries)
3. Side panel UI (chat component + trace entry point)
4. Full page UI (list + detail views + standalone entry point)
5. Alert entry point (semi-auto investigation trigger)
6. Export + sharing
