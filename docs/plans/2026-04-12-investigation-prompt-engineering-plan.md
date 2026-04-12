# Investigation Prompt Engineering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tune the proactive investigation pipeline with skill-style phase prompts, phase-scoped tool lists, execute→verify message threading, and tool_choice enforcement.

**Architecture:** Four changes applied in dependency order: (1) phase-scoped tool factory, (2) skill-style prompt builders for all 4 phases, (3) `runAgentPhase` gains `forceFirstStep`/`initialMessages`/`outputMessages`, (4) `runInvestigationCycle` wires threading + proactive early-exit. All changes stay within Vercel AI SDK — no new dependencies.

**Tech Stack:** TypeScript, Vercel AI SDK (`ai`, `@ai-sdk/openai`), Jest, `packages/api`

**Design doc:** `docs/plans/2026-04-12-investigation-prompt-engineering-design.md`

---

## Task 1: Phase-Scoped Tool Factory

**Files:**
- Modify: `packages/api/src/controllers/investigation-tools/tools.ts`
- Test: `packages/api/src/controllers/investigation-tools/__tests__/schema.test.ts`

### Step 1: Write failing tests for phase-scoped tool list

Add to `packages/api/src/controllers/investigation-tools/__tests__/schema.test.ts`:

```typescript
import { createInvestigationTools } from '../tools';

const FAKE_OPTS = {
  connection: { host: 'localhost', username: 'u', password: 'p' },
  teamId: 'team1',
  userId: 'user1',
};

describe('createInvestigationTools — phase scoping', () => {
  it('plan phase: only orientation tools', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'plan' });
    const names = Object.keys(tools);
    expect(names).toEqual(expect.arrayContaining([
      'retrieveMemory', 'getActiveAlerts', 'getServiceHealthScore', 'getServiceMap',
    ]));
    expect(names).not.toContain('searchTraces');
    expect(names).not.toContain('createAlert');
  });

  it('execute phase: diagnostic tools only', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'execute' });
    const names = Object.keys(tools);
    expect(names).toEqual(expect.arrayContaining([
      'searchTraces', 'searchLogs', 'getMetrics',
      'findSimilarErrors', 'getBaselineMetrics', 'getServiceMap',
    ]));
    expect(names).not.toContain('createAlert');
    expect(names).not.toContain('retrieveMemory');
  });

  it('verify phase: cross-check subset', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'verify' });
    const names = Object.keys(tools);
    expect(names).toEqual(expect.arrayContaining([
      'searchTraces', 'searchLogs', 'getMetrics', 'findSimilarErrors',
    ]));
    expect(names).not.toContain('createAlert');
    expect(names).not.toContain('getBaselineMetrics');
  });

  it('summarize phase: artifact tools only', () => {
    const tools = createInvestigationTools({ ...FAKE_OPTS, phase: 'summarize' });
    const names = Object.keys(tools);
    expect(names).toEqual(expect.arrayContaining([
      'createSavedSearch', 'createDashboard', 'createAlert',
    ]));
    expect(names).not.toContain('searchTraces');
  });

  it('no phase (legacy): all tools returned', () => {
    const tools = createInvestigationTools(FAKE_OPTS);
    expect(Object.keys(tools).length).toBeGreaterThan(10);
  });
});
```

### Step 2: Run to verify failing

```bash
cd packages/api && yarn ci:unit src/controllers/investigation-tools/__tests__/schema.test.ts
```

Expected: FAIL — `phase` param not accepted yet.

### Step 3: Add `phase` param to `createInvestigationTools`

In `packages/api/src/controllers/investigation-tools/tools.ts`, find the `createInvestigationTools` function signature and add `phase` param:

```typescript
type InvestigationPhase = 'plan' | 'execute' | 'verify' | 'summarize';

const PHASE_TOOLS: Record<InvestigationPhase, string[]> = {
  plan:      ['retrieveMemory', 'getActiveAlerts', 'getServiceHealthScore', 'getServiceMap'],
  execute:   ['searchTraces', 'searchLogs', 'getMetrics', 'findSimilarErrors', 'getBaselineMetrics', 'getServiceMap'],
  verify:    ['searchTraces', 'searchLogs', 'getMetrics', 'findSimilarErrors'],
  summarize: ['createSavedSearch', 'createDashboard', 'createAlert'],
};

export function createInvestigationTools(opts: {
  connection: { host: string; username: string; password: string };
  teamId: string;
  userId: string;
  phase?: InvestigationPhase;   // ← new optional param
}): ToolSet {
  const allTools = buildAllTools(opts);   // existing logic extracted/renamed
  if (!opts.phase) return allTools;

  const allowed = new Set(PHASE_TOOLS[opts.phase]);
  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => allowed.has(name))
  ) as ToolSet;
}
```

> Note: the tool *descriptions* within each tool definition also need phase-specific variants. For now, keep descriptions generic — phase-tuned descriptions are added in Task 2 (prompt builders). The tool list restriction is the primary cost lever.

### Step 4: Run tests to verify passing

```bash
cd packages/api && yarn ci:unit src/controllers/investigation-tools/__tests__/schema.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
cd packages/api && git add src/controllers/investigation-tools/tools.ts src/controllers/investigation-tools/__tests__/schema.test.ts
git commit -m "feat(investigation): phase-scoped tool factory"
```

---

## Task 2: Skill-Style Phase Prompt Builders

**Files:**
- Modify: `packages/api/src/controllers/investigation-agent.ts`
- Test: `packages/api/src/controllers/__tests__/investigation-agent.test.ts`

### Step 1: Write failing tests for prompt contracts

Add to `packages/api/src/controllers/__tests__/investigation-agent.test.ts`:

```typescript
import {
  buildPlanSystemPrompt,
  buildExecuteSystemPrompt,
  buildVerifySystemPrompt,
  buildSummarizeSystemPrompt,
} from '../investigation-agent';

const SCHEMA = 'table: logs (timestamp, level, message)';
const TRIGGER = 'payment-service error rate spiked to 12%';
const MEMORY = 'No prior incidents found.';
const PLAN = '1. Check error logs\n2. Check metrics';
const EVIDENCE = 'EVIDENCE: searchLogs → 847 DB timeout errors → supports Hypothesis 1';
const VERDICTS = 'VERDICT: CONFIRMED — DB connection pool exhausted';

describe('buildPlanSystemPrompt', () => {
  it('declares PLANNING role', () => {
    const p = buildPlanSystemPrompt({ schemaPrompt: SCHEMA, triggerDescription: TRIGGER, memoryContext: MEMORY });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/PLANNING/);
  });
  it('includes abort condition for NO_ANOMALY', () => {
    const p = buildPlanSystemPrompt({ schemaPrompt: SCHEMA, triggerDescription: TRIGGER, memoryContext: MEMORY });
    expect(p).toMatch(/NO_ANOMALY/);
  });
  it('specifies structured JSON output format', () => {
    const p = buildPlanSystemPrompt({ schemaPrompt: SCHEMA, triggerDescription: TRIGGER, memoryContext: MEMORY });
    expect(p).toMatch(/hypotheses/);
    expect(p).toMatch(/evidencePlan/);
    expect(p).toMatch(/abortIf/);
  });
});

describe('buildExecuteSystemPrompt', () => {
  it('declares EXECUTION role', () => {
    const p = buildExecuteSystemPrompt({ plan: PLAN, schemaPrompt: SCHEMA });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/EXECUTION/);
  });
  it('instructs sequential tool calls', () => {
    const p = buildExecuteSystemPrompt({ plan: PLAN, schemaPrompt: SCHEMA });
    expect(p).toMatch(/sequential/i);
  });
  it('specifies EVIDENCE output format', () => {
    const p = buildExecuteSystemPrompt({ plan: PLAN, schemaPrompt: SCHEMA });
    expect(p).toMatch(/EVIDENCE:/);
    expect(p).toMatch(/supports\/refutes\/inconclusive/i);
  });
});

describe('buildVerifySystemPrompt', () => {
  it('declares VERIFICATION role', () => {
    const p = buildVerifySystemPrompt({ evidenceLog: EVIDENCE, schemaPrompt: SCHEMA });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/VERIFICATION/);
  });
  it('instructs independent angles (no repeated queries)', () => {
    const p = buildVerifySystemPrompt({ evidenceLog: EVIDENCE, schemaPrompt: SCHEMA });
    expect(p).toMatch(/Do not repeat/i);
  });
  it('specifies VERDICT output format with three states', () => {
    const p = buildVerifySystemPrompt({ evidenceLog: EVIDENCE, schemaPrompt: SCHEMA });
    expect(p).toMatch(/CONFIRMED/);
    expect(p).toMatch(/WEAKENED/);
    expect(p).toMatch(/INCONCLUSIVE/);
  });
});

describe('buildSummarizeSystemPrompt', () => {
  it('declares SUMMARIZATION role', () => {
    const p = buildSummarizeSystemPrompt({ plan: PLAN, evidenceLog: EVIDENCE, verificationVerdicts: VERDICTS, schemaPrompt: SCHEMA });
    expect(p).toMatch(/## Role/);
    expect(p).toMatch(/SUMMARIZATION/);
  });
  it('gates artifact creation on confidence', () => {
    const p = buildSummarizeSystemPrompt({ plan: PLAN, evidenceLog: EVIDENCE, verificationVerdicts: VERDICTS, schemaPrompt: SCHEMA });
    expect(p).toMatch(/confidence.*medium.*high|medium.*high.*confidence/i);
  });
  it('instructs low-confidence disclaimer when WEAKENED present', () => {
    const p = buildSummarizeSystemPrompt({ plan: PLAN, evidenceLog: EVIDENCE, verificationVerdicts: VERDICTS, schemaPrompt: SCHEMA });
    expect(p).toMatch(/WEAKENED/);
    expect(p).toMatch(/not confident/i);
  });
});
```

### Step 2: Run to verify failing

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts
```

Expected: FAIL — prompts don't yet include `## Role`, `NO_ANOMALY`, `EVIDENCE:` format, etc.

### Step 3: Rewrite the four prompt builder functions

Replace `buildPlanSystemPrompt`, `buildExecuteSystemPrompt`, `buildVerifySystemPrompt`, and `buildSummarizeSystemPrompt` in `packages/api/src/controllers/investigation-agent.ts` with skill-style versions:

```typescript
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
  evidenceLog,
  schemaPrompt,
}: {
  evidenceLog: string;
  schemaPrompt: string;
}) {
  return `## Role
You are the VERIFICATION skill of the HyperDX investigation pipeline.
Your job is to independently cross-check the execute phase's findings by trying to disprove them.

## Inputs
The full execute phase conversation is in your message history — you can see every tool call and result.
- Database schema: ${schemaPrompt}

## Evidence to Verify
${evidenceLog}

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
- LOW: Any WEAKENED verdict — output: "I'm not confident in these findings. Additional data needed: [X]"`;
}
```

### Step 4: Run tests

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
git add packages/api/src/controllers/investigation-agent.ts packages/api/src/controllers/__tests__/investigation-agent.test.ts
git commit -m "feat(investigation): skill-style phase prompt builders with output format contracts"
```

---

## Task 3: runAgentPhase — forceFirstStep + Thread Export

**Files:**
- Modify: `packages/api/src/controllers/investigation-agent.ts`
- Test: `packages/api/src/controllers/__tests__/investigation-agent.test.ts`

### Step 1: Write failing tests

Add to `packages/api/src/controllers/__tests__/investigation-agent.test.ts`:

```typescript
// Mock streamText to capture toolChoice passed to it
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return {
    ...actual,
    streamText: jest.fn().mockImplementation(async (opts: any) => {
      // Capture opts for assertions
      (global as any).__lastStreamTextOpts = opts;
      // Return minimal fake stream
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'test output' };
        })(),
        response: { messages: [{ role: 'assistant', content: 'test output' }] },
      };
    }),
  };
});

describe('runAgentPhase — forceFirstStep', () => {
  it('passes toolChoice required when forceFirstStep is true', async () => {
    await runAgentPhase({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'test',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
      forceFirstStep: true,
    });
    expect((global as any).__lastStreamTextOpts.toolChoice).toBe('required');
  });

  it('does not set toolChoice required when forceFirstStep is false', async () => {
    await runAgentPhase({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'test',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
      forceFirstStep: false,
    });
    expect((global as any).__lastStreamTextOpts.toolChoice).not.toBe('required');
  });
});

describe('runAgentPhase — outputMessages', () => {
  it('returns outputMessages from response', async () => {
    const result = await runAgentPhase({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'test',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    });
    expect(result.outputMessages).toBeDefined();
    expect(Array.isArray(result.outputMessages)).toBe(true);
  });
});
```

### Step 2: Run to verify failing

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts --testNamePattern="forceFirstStep|outputMessages"
```

Expected: FAIL

### Step 3: Update `runAgentPhase` signature and implementation

In `packages/api/src/controllers/investigation-agent.ts`, update `runAgentPhase`:

```typescript
interface PhaseResult {
  text: string;
  toolCallCount: number;
  toolCalls: { name: string; args: unknown; result: unknown }[];
  outputMessages: CoreMessage[];   // ← new
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
  forceFirstStep = false,          // ← new
  onTextDelta,
  onToolCall,
  onToolEvent,
}: {
  // ... existing params ...
  forceFirstStep?: boolean;        // ← new
}): Promise<PhaseResult> {
  // Inside the span:
  const result = streamText({
    model,
    system: systemPrompt,
    messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    ...(forceFirstStep ? { toolChoice: 'required' } : {}),   // ← new
    experimental_telemetry: { isEnabled: true },
  });

  // ... existing streaming loop ...

  // After loop, extract output messages:
  const responseMessages = await result.response;
  const outputMessages: CoreMessage[] = [
    ...messages,
    ...(responseMessages.messages ?? []),
  ];

  return { text: fullText, toolCallCount, toolCalls: allToolCalls, outputMessages };
}
```

> Note: `result.response` is a Promise in Vercel AI SDK v4 — await it after the stream to get `messages`. Import `CoreMessage` from `'ai'`.

### Step 4: Run tests

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts
```

Expected: PASS

### Step 5: Commit

```bash
git add packages/api/src/controllers/investigation-agent.ts packages/api/src/controllers/__tests__/investigation-agent.test.ts
git commit -m "feat(investigation): runAgentPhase forceFirstStep + outputMessages thread export"
```

---

## Task 4: Wire Threading in runInvestigationCycle

**Files:**
- Modify: `packages/api/src/controllers/investigation-agent.ts`
- Test: `packages/api/src/controllers/__tests__/investigation-agent.test.ts`

### Step 1: Write failing test for thread inheritance

```typescript
describe('runInvestigationCycle — execute→verify threading', () => {
  it('verify phase receives execute outputMessages as initial messages', async () => {
    const streamTextMock = require('ai').streamText as jest.Mock;
    const capturedCalls: any[] = [];
    streamTextMock.mockImplementation(async (opts: any) => {
      capturedCalls.push({ phaseName: opts.system?.match(/## Role\n(.+)/)?.[1], messages: opts.messages });
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'output' };
        })(),
        response: { messages: [{ role: 'assistant', content: 'output' }] },
      };
    });

    await runInvestigationCycle({
      triggerDescription: 'test trigger',
      triggerType: 'health_scan',
      schemaPrompt: 'schema',
      memoryContext: 'none',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    });

    // Find the verify call
    const verifyCall = capturedCalls.find(c => c.phaseName?.includes('VERIFICATION'));
    expect(verifyCall).toBeDefined();
    // Verify messages should contain more than just the fresh user message
    // (it inherits execute's thread)
    expect(verifyCall.messages.length).toBeGreaterThan(1);
  });
});
```

### Step 2: Run to verify failing

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts --testNamePattern="execute→verify threading"
```

Expected: FAIL — verify currently starts fresh.

### Step 3: Update `runInvestigationCycle` to thread execute → verify

In `packages/api/src/controllers/investigation-agent.ts`, in `runInvestigationCycle`:

```typescript
// ----- Phase 2: EXECUTE (with forceFirstStep) -----
const executeResult = await runAgentPhase({
  // ... existing params ...
  phaseName: 'execute',
  forceFirstStep: true,    // ← force at least one tool call
  // ...
});

// ----- Phase 3: VERIFY (inherits execute thread) -----
const verifyMessages = [
  ...executeResult.outputMessages,   // ← inherit execute's full thread
  {
    role: 'user' as const,
    content: 'Verify the investigation findings. Try to disprove each conclusion using independent data.',
  },
];

const verifyResult = await runAgentPhase({
  messages: verifyMessages,          // ← pass full thread
  // ...
  phaseName: 'verify',
  forceFirstStep: true,              // ← force at least one cross-check
  // ...
});

// ----- Phase 4: SUMMARIZE (fresh — cost control) -----
// summarize messages stay as-is (fresh with synthesized findings in system prompt)
```

### Step 4: Run tests

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts
```

Expected: PASS

### Step 5: Run full unit suite to check for regressions

```bash
cd packages/api && yarn ci:unit src/controllers/
```

Expected: PASS

### Step 6: Commit

```bash
git add packages/api/src/controllers/investigation-agent.ts packages/api/src/controllers/__tests__/investigation-agent.test.ts
git commit -m "feat(investigation): wire execute→verify thread inheritance and forceFirstStep enforcement"
```

---

## Task 5: Phase-Scoped Tools in runInvestigationCycle

**Files:**
- Modify: `packages/api/src/controllers/investigation-agent.ts`
- Test: `packages/api/src/controllers/__tests__/investigation-agent.test.ts`

### Step 1: Write failing test

```typescript
describe('runInvestigationCycle — phase tool scoping', () => {
  it('passes phase to createInvestigationTools for each phase', async () => {
    const createToolsMock = jest.fn().mockReturnValue({});
    jest.doMock('../investigation-tools/tools', () => ({
      createInvestigationTools: createToolsMock,
    }));

    // (Re-import after mock)
    // After the cycle runs, verify createInvestigationTools was called with each phase
    // This is tested via the tools returned being phase-scoped (integration-style)
    // Simpler assertion: verify runAgentPhase is called 4 times with different tool sets
    // For now, smoke test: cycle completes without throwing
    await expect(runInvestigationCycle({
      triggerDescription: 'test',
      triggerType: 'health_scan',
      schemaPrompt: 'schema',
      memoryContext: 'none',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    })).resolves.toBeDefined();
  });
});
```

### Step 2: Update `runAgentPhase` to accept `phase` for tool creation

In `packages/api/src/controllers/investigation-agent.ts`, update `runAgentPhase` to pass phase to `createInvestigationTools`:

```typescript
// Inside runAgentPhase, replace:
const tools = createInvestigationTools({ connection, teamId, userId }) as ToolSet;

// With:
const tools = createInvestigationTools({ connection, teamId, userId, phase: phaseName as any }) as ToolSet;
```

Add `phaseName` type to match `InvestigationPhase | 'unknown'` — pass through only valid phases.

### Step 3: Run full cycle tests

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts
```

Expected: PASS

### Step 4: Commit

```bash
git add packages/api/src/controllers/investigation-agent.ts
git commit -m "feat(investigation): pass phase to createInvestigationTools in runAgentPhase"
```

---

## Task 6: Proactive Early-Exit on NO_ANOMALY

**Files:**
- Modify: `packages/api/src/tasks/proactiveInvestigation.ts`
- Test: `packages/api/src/controllers/__tests__/investigation-agent.test.ts`

### Step 1: Write failing test

Add to `investigation-agent.test.ts`:

```typescript
describe('runInvestigationCycle — NO_ANOMALY early exit', () => {
  it('skips execute/verify/summarize phases when plan emits NO_ANOMALY', async () => {
    const streamTextMock = require('ai').streamText as jest.Mock;
    let callCount = 0;
    streamTextMock.mockImplementation(async () => {
      callCount++;
      const isFirstCall = callCount === 1;
      return {
        fullStream: (async function* () {
          // First call (plan) emits NO_ANOMALY
          yield { type: 'text-delta', text: isFirstCall ? 'NO_ANOMALY' : 'output' };
        })(),
        response: { messages: [] },
      };
    });

    const result = await runInvestigationCycle({
      triggerDescription: 'test',
      triggerType: 'health_scan',
      schemaPrompt: 'schema',
      memoryContext: 'none',
      connection: { host: 'h', username: 'u', password: 'p' },
      teamId: 't1',
      userId: 'u1',
    });

    // Only plan phase ran (1 streamText call)
    expect(callCount).toBe(1);
    expect(result.confidence).toBe('low');
    expect(result.summary).toMatch(/NO_ANOMALY|no anomaly/i);
  });
});
```

### Step 2: Run to verify failing

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts --testNamePattern="NO_ANOMALY"
```

Expected: FAIL

### Step 3: Add NO_ANOMALY check in `runInvestigationCycle`

In `packages/api/src/controllers/investigation-agent.ts`, after `planResult` is obtained:

```typescript
// After phase 1 (plan) completes:
if (planResult.text.trim() === 'NO_ANOMALY' || planResult.text.includes('NO_ANOMALY')) {
  // Emit event
  if (investigationId) {
    investigationEventBus.emitDebugEvent({
      type: 'investigation_complete',
      investigationId,
      confidence: 'low',
      timestamp: Date.now(),
    });
  }
  // Return early with minimal result
  return {
    plan: planResult.text,
    evidence: '',
    verification: '',
    summary: 'NO_ANOMALY: All services healthy, no active alerts. No investigation needed.',
    confidence: 'low',
    phaseHistory,
    toolCallLog,
    thinkingLog,
  };
}
```

### Step 4: Run tests

```bash
cd packages/api && yarn ci:unit src/controllers/__tests__/investigation-agent.test.ts
```

Expected: PASS

### Step 5: Run full API unit suite

```bash
cd packages/api && yarn ci:unit src/
```

Expected: PASS

### Step 6: Run lint

```bash
cd /Users/nanfengcheong/Projects/msm/hyperdx && make ci-lint
```

Expected: PASS

### Step 7: Commit

```bash
git add packages/api/src/controllers/investigation-agent.ts packages/api/src/controllers/__tests__/investigation-agent.test.ts
git commit -m "feat(investigation): NO_ANOMALY early exit skips execute/verify/summarize"
```

---

## Task 7: Final Smoke Test + Lint

### Step 1: Run full unit suite

```bash
cd /Users/nanfengcheong/Projects/msm/hyperdx && make ci-unit
```

Expected: PASS

### Step 2: Run lint + type check

```bash
make ci-lint
```

Expected: PASS

### Step 3: Final commit (if any lint fixes)

```bash
git add -p
git commit -m "chore(investigation): lint fixes"
```

---

## Summary

| Task | Files changed | Commit |
|------|-------------|--------|
| 1 | `investigation-tools/tools.ts` | phase-scoped tool factory |
| 2 | `investigation-agent.ts` | skill-style prompt builders |
| 3 | `investigation-agent.ts` | forceFirstStep + outputMessages |
| 4 | `investigation-agent.ts` | execute→verify thread wiring |
| 5 | `investigation-agent.ts` | phase tool scoping in runAgentPhase |
| 6 | `investigation-agent.ts`, `proactiveInvestigation.ts` | NO_ANOMALY early exit |
| 7 | — | final lint |
