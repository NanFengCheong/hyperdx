# Investigation Prompt Engineering Design

**Date:** 2026-04-12  
**Scope:** `packages/api/src/controllers/investigation-agent.ts`, `investigation-tools/tools.ts`, `tasks/proactiveInvestigation.ts`  
**Constraints:** Cost-sensitive (qwen-plus-latest locked), Vercel AI SDK retained

---

## Problem

The current 4-phase investigation cycle has three structural weaknesses:

1. **Phase isolation** — each phase starts a fresh conversation. The verify phase
   sees only a text summary of execute's findings, not the actual tool call results.
   This produces shallow cross-checks.

2. **Tool list too broad** — all 13 tools available in all phases. Plan phase can
   accidentally create alerts; summarize phase re-queries instead of synthesizing.
   Larger tool schemas = higher per-call token cost.

3. **No tool_choice enforcement** — execute and verify phases can produce prose
   without calling a single tool. No structural guarantee of evidence gathering.

---

## Decision: Approach C — Selective Thread + Phase Tool Restriction

- **Plan**: fresh conversation, read-only orientation tools, `toolChoice: auto`
- **Execute**: fresh conversation + plan in system prompt, diagnostic tools only,
  `toolChoice: 'required'` first step
- **Verify**: **inherits execute's conversation thread** (real tool results visible),
  cross-check tools only, `toolChoice: 'required'` first step
- **Summarize**: fresh conversation + structured findings in system prompt,
  artifact-creation tools only, `toolChoice: 'auto'`

Thinking mode (`enable_thinking`) stays **off** — cost constraint. No OpenAI Node.js
SDK migration needed; Vercel AI SDK covers all required features.

---

## Section 1: Tool List Per Phase

`createInvestigationTools(opts)` gains a `phase` parameter.

| Phase | Tools | Rationale |
|-------|-------|-----------|
| **plan** | `retrieveMemory`, `getActiveAlerts`, `getServiceHealthScore`, `getServiceMap` | Orient only — check memory + current health before planning. No data queries. |
| **execute** | `searchTraces`, `searchLogs`, `getMetrics`, `findSimilarErrors`, `getBaselineMetrics`, `getServiceMap` | Evidence gathering. No artifact creation, no memory reads. |
| **verify** | `searchTraces`, `searchLogs`, `getMetrics`, `findSimilarErrors` | Cross-check subset — narrower than execute to force independent evidence paths. |
| **summarize** | `createSavedSearch`, `createDashboard`, `createAlert` | Artifact creation only. Model has full evidence in context — no re-querying. |

---

## Section 2: Skill-Style Phase Prompts

Each phase prompt follows a structured contract — matching the Claude Code skill
pattern: role → inputs → tools (with phase-tuned descriptions) → task steps →
output format → success/abort conditions.

### Key principle: tool descriptions change per phase

Same tool, different description based on investigative posture:

| Tool | execute description | verify description |
|------|--------------------|--------------------|
| `searchLogs` | "Find error/warn log patterns to build evidence for each hypothesis" | "Independently verify a finding — search for the same pattern the execute phase found, or look for contradicting evidence" |
| `searchTraces` | "Find slow/failed traces to confirm a hypothesis" | "Check traces execute did NOT check — test whether the problem is upstream or downstream" |
| `getMetrics` | "Get time-series data to measure the anomaly's scope and timing" | "Check a wider time window (3h/24h) to distinguish spike vs trend — do not repeat execute's exact queries" |

Phase-tuned descriptions are the primary mechanism for guiding tool call behavior.
They eliminate verbose prose instructions — the tool list itself communicates
investigative posture.

### Prompt structure per phase (template)

```
## Role
You are the [PHASE] skill of the HyperDX investigation pipeline.
[One-sentence role statement — what this skill produces.]

## Inputs
[Structured description of exactly what has been provided:
 trigger text / plan / evidence log / verification verdicts]

## Tools
[Phase-scoped list with phase-specific descriptions — see Section 1]

## Task
1. [Step 1 — imperative, specific]
2. [Step 2]
...

## Output Format
[Exact schema the next phase or caller expects]

## Success Criteria
[What "done" looks like — e.g., "all hypotheses have a verdict"]

## Abort Conditions
[When to stop early — e.g., "if all baseline metrics are normal, output
 NO_ANOMALY and skip to summarize"]
```

### Plan phase prompt additions

- Abort condition: if `getActiveAlerts` returns empty AND `getServiceHealthScore`
  shows all green, emit `NO_ANOMALY` signal — proactive task skips execute/verify
  and jumps directly to a brief summarize.
- Output format: structured JSON block with `hypotheses[]`, `evidencePlan[]`,
  `successCriteria[]`, `abortIf` fields — parseable by the orchestrator.

### Execute phase prompt additions

- Explicit constraint: "Call tools sequentially — analyze each result before
  deciding the next call. Do not batch."
- Evidence format per tool call:
  `EVIDENCE: [tool_name] → [key finding] → [supports/refutes/inconclusive] Hypothesis N`

### Verify phase prompt additions

- Explicit constraint: "Do not repeat any tool call the execute phase already made
  with the same arguments. Use independent angles."
- Verdict format per finding:
  `VERDICT: [CONFIRMED|WEAKENED|INCONCLUSIVE] — [reason] — [evidence citation]`

### Summarize phase prompt additions

- Confidence gating: if verification produced ≥1 WEAKENED verdict, set
  `confidence: low` and add "I'm not confident — additional data needed: [X]"
- Artifact creation guidance: only create artifacts if confidence is medium or high.

---

## Section 3: Message Threading + tool_choice Enforcement

### Execute → Verify thread hand-off

`runAgentPhase` gains an `outputMessages` return field — the full Vercel AI SDK
`CoreMessage[]` array extracted from `result.response.messages` after stream
completes.

```
plan:      messages = [{ role: 'user', content: 'Plan...' }]   → fresh
execute:   messages = [{ role: 'user', content: 'Execute...' }] → fresh
             returns: outputMessages (full thread with real tool call/result pairs)
                ↓
verify:    messages = [...executeOutputMessages,
                        { role: 'user', content: 'Now verify...' }]
             → INHERITS execute thread, sees actual tool results
summarize: messages = [{ role: 'user', content: 'Synthesize...' }] → fresh
             (structured text findings injected via system prompt — not raw thread)
```

Summarize resets to control cost accumulation. It receives a compact synthesized
text block (plan + evidence summary + verification verdicts), not the raw thread.

### tool_choice per phase

| Phase | toolChoice | How |
|-------|------------|-----|
| plan | `'auto'` | May orient via memory/health, not required |
| execute | `'required'` turn 1, then `'auto'` | `runAgentPhase` gains `forceFirstStep?: boolean` — passes `toolChoice: 'required'` only for the initial `streamText` call |
| verify | `'required'` turn 1, then `'auto'` | Same mechanism |
| summarize | `'auto'` | Artifact creation encouraged, not forced |

Implementation: `runAgentPhase` signature adds:
```typescript
forceFirstStep?: boolean        // sets toolChoice: 'required' on first streamText call
initialMessages?: CoreMessage[] // if provided, prepended to messages (for verify)
outputMessages?: CoreMessage[]  // populated after run — returned to caller
```

---

## Section 4: Proactive Benchmark → Production Alignment

The benchmark's `hypothesize → gather → report` maps to the production 4-phase cycle:

| Benchmark turn | Production phase | tool_choice |
|----------------|-----------------|-------------|
| hypothesize (`none`) | plan | `auto` (orientation tools optional) |
| gather round 1 (`required`) | execute turn 1 | `required` |
| gather rounds 2–N (`auto`) | execute turns 2–8 | `auto` |
| verify (`required`) | verify turn 1 | `required` |
| report (`none`) | summarize | `auto` (artifact tools) |

The `ProactiveInvestigationTask` adds a **pre-scan early-exit**: before running
the full cycle, call `getActiveAlerts` + `getServiceHealthScore` (plan phase).
If plan emits `NO_ANOMALY`, log and skip — avoids paying 22 tool call budget for
a healthy system.

---

## Files to Change

| File | Change |
|------|--------|
| `controllers/investigation-agent.ts` | All 4 phase prompt builders (skill-style), `runAgentPhase` signature (`forceFirstStep`, `initialMessages`, `outputMessages`), `runInvestigationCycle` threading logic |
| `controllers/investigation-tools/tools.ts` | `createInvestigationTools` gains `phase` param, returns phase-scoped subset with phase-tuned descriptions |
| `tasks/proactiveInvestigation.ts` | Pre-scan early-exit on `NO_ANOMALY` signal from plan phase |
| `controllers/__tests__/investigation-agent.test.ts` | Update tests for new signatures and phase prompt contracts |

---

## Cost Impact (estimated)

| Change | Token effect |
|--------|-------------|
| Phase tool restriction | −20–35% per-call schema tokens (13 → 4–6 tools) |
| Summarize resets thread | Prevents unbounded context growth |
| `NO_ANOMALY` early exit | Skips 19/22 tool calls on healthy systems |
| Thinking mode OFF | No change (already off) |

Net: significant reduction in cost per proactive cycle, especially for healthy
systems (most cycles in practice).
