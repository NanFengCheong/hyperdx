import opentelemetry, { Counter, metrics } from '@opentelemetry/api';

import { CODE_VERSION } from '@/config';
import {
  type InvestigationCycleResult,
  runInvestigationCycle,
} from '@/controllers/investigation-agent';
import {
  buildSchemaPrompt,
  fetchClickHouseSchema,
} from '@/controllers/investigation-tools/schema';
import Connection from '@/models/connection';
import Investigation, { LoopPhase } from '@/models/investigation';
import InvestigationMemory from '@/models/investigationMemory';
import Team from '@/models/team';
import User from '@/models/user';
import {
  HdxTask,
  ProactiveInvestigationTaskArgs,
  TaskName,
} from '@/tasks/types';
import logger from '@/utils/logger';

// OTel primitives (inline)
const investigationTracer = opentelemetry.trace.getTracer(
  'hyperdx-investigation',
  CODE_VERSION,
);
const meter = metrics.getMeter('hyperdx-investigation');
const cycleFailureCounter: Counter = meter.createCounter(
  'hyperdx.investigation.cycle.failure',
  { description: 'Count of failed investigation cycles' },
);

export default class ProactiveInvestigationTask
  implements HdxTask<ProactiveInvestigationTaskArgs>
{
  constructor(private readonly args: ProactiveInvestigationTaskArgs) {}

  name(): string {
    return TaskName.PROACTIVE_INVESTIGATION;
  }

  async execute(): Promise<void> {
    const { teamId } = this.args;

    const query = teamId ? { _id: teamId } : {};
    const teams = await Team.find(query);

    logger.info(
      `Starting proactive investigation cycle for ${teams.length} teams`,
    );

    for (const team of teams) {
      try {
        await this.investigateTeam(team._id.toString());
      } catch (err) {
        logger.error(
          { err, teamId: team._id },
          `Proactive investigation failed for team ${team._id}`,
        );
      }
    }
  }

  private async investigateTeam(teamId: string): Promise<void> {
    return investigationTracer.startActiveSpan(
      `investigation.team.${teamId}`,
      async teamSpan => {
        teamSpan.setAttribute('hyperdx.investigation.team.id', teamId);
        teamSpan.setAttribute('hyperdx.investigation.source', 'proactive_task');

        try {
          await this.investigateTeamInternal(teamId);
        } catch (err) {
          cycleFailureCounter.add(1, {
            'hyperdx.investigation.team.id': teamId,
            'hyperdx.investigation.trigger.type': 'health_scan',
          });
          teamSpan.recordException(err as Error);
          throw err;
        } finally {
          teamSpan.end();
        }
      },
    );
  }

  private async investigateTeamInternal(teamId: string): Promise<void> {
    // 1. Find a user to act as the "creator"
    const user = await User.findOne({ team: teamId });
    if (!user) {
      logger.warn(
        { teamId },
        'No user found for team, skipping proactive investigation',
      );
      return;
    }

    // 2. Find a connection
    const connection = await Connection.findOne({ team: teamId }).select(
      '+password',
    );
    if (!connection) {
      logger.warn(
        { teamId },
        'No connection found for team, skipping proactive investigation',
      );
      return;
    }

    // 3. Fetch schema
    const schema = await fetchClickHouseSchema(
      teamId,
      connection._id.toString(),
    );
    const schemaPrompt = buildSchemaPrompt(schema);

    // 4. Gather memory context (recent findings for this team)
    const memoryContext = await this.getMemoryContext(teamId);

    // 5. Create investigation record with loop state
    const investigation = await Investigation.create({
      team: teamId,
      createdBy: user._id,
      title: `Proactive Health Check - ${new Date().toISOString()}`,
      status: 'active',
      entryPoint: { type: 'standalone' },
      messages: [
        {
          role: 'user',
          content:
            'Perform a proactive health check of the system for the last 1 hour.',
          timestamp: new Date(),
        },
      ],
      loopState: {
        currentPhase: 'plan',
        plan: null,
        evidence: null,
        verification: null,
        phaseHistory: [],
      },
    });

    logger.info(
      { teamId, investigationId: investigation._id },
      'Starting multi-phase investigation cycle',
    );

    // 6. Run the full cycle
    const cycleResult = await runInvestigationCycle({
      triggerDescription:
        'Scheduled proactive health check. Scan all services for error rate spikes, latency regressions, failing traces, and abnormal log patterns. If anomalies are detected, investigate further to find root cause.',
      triggerType: 'health_scan',
      schemaPrompt,
      memoryContext,
      connection: {
        host: connection.host,
        username: connection.username,
        password: connection.password,
      },
      teamId,
      userId: user._id.toString(),
      onPhaseUpdate: async (phase, output) => {
        // Update loop state in MongoDB as each phase completes
        await Investigation.findByIdAndUpdate(investigation._id, {
          $set: {
            [`loopState.currentPhase`]: getNextPhase(phase),
            [`loopState.${phase}`]: output,
          },
          $push: {
            'loopState.phaseHistory': getPhaseHistoryEntry(phase, output),
          },
        });
      },
    });

    // 7. Update investigation with final state
    await Investigation.findByIdAndUpdate(investigation._id, {
      $set: {
        summary: cycleResult.summary,
        'loopState.currentPhase': 'complete',
        'loopState.plan': cycleResult.plan,
        'loopState.evidence': cycleResult.evidence,
        'loopState.verification': cycleResult.verification,
        status: cycleResult.confidence === 'high' ? 'resolved' : 'active',
      },
    });

    // 8. Persist to long-term memory
    await this.persistMemory({
      teamId,
      investigationId: investigation._id.toString(),
      cycleResult,
      userId: user._id.toString(),
    });

    logger.info(
      {
        teamId,
        investigationId: investigation._id,
        confidence: cycleResult.confidence,
      },
      'Proactive investigation cycle completed',
    );
  }

  /**
   * Build memory context string for the planning phase prompt.
   * Retrieves recent investigation findings for this team.
   */
  private async getMemoryContext(teamId: string): Promise<string> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7); // Look back 7 days

    const memories = await InvestigationMemory.find({
      teamId,
      resolvedAt: { $gte: cutoff },
    })
      .sort({ resolvedAt: -1 })
      .limit(10)
      .lean();

    if (memories.length === 0) {
      return 'No past investigation findings found. This is a fresh environment or no issues have been detected recently.';
    }

    const lines = memories.map(m => {
      const findings = m.findings
        .map(
          f =>
            `- ${f.service}: ${f.symptom} → ${f.rootCause} (verified: ${f.wasVerified}, recurrence: ${m.recurrenceCount})`,
        )
        .join('\n');
      return `**${m.resolvedAt.toISOString()}** (${m.triggerType}, confidence: ${m.confidence})\n${findings}\nArtifacts: ${m.artifactsCreated.map(a => `${a.type}:${a.id}`).join(', ') || 'none'}`;
    });

    return `Recent investigation findings (last 7 days):\n\n${lines.join('\n\n')}`;
  }

  /**
   * Persist investigation results to long-term memory store.
   */
  private async persistMemory({
    teamId,
    investigationId,
    cycleResult,
    userId,
  }: {
    teamId: string;
    investigationId: string;
    cycleResult: InvestigationCycleResult;
    userId: string;
  }): Promise<void> {
    try {
      // Extract findings from the evidence + verification
      const findings = this.extractFindingsFromText(
        cycleResult.evidence,
        cycleResult.verification,
      );

      // Extract artifact IDs from the summary (best-effort regex parsing)
      const artifacts = this.extractArtifactsFromSummary(cycleResult.summary);

      await InvestigationMemory.create({
        teamId,
        investigationId,
        findings,
        artifactsCreated: artifacts,
        resolvedAt: new Date(),
        recurrenceCount: this.computeRecurrenceCount(findings, teamId),
        baselineMetrics: {}, // Baselines are computed in getBaselineMetrics tool calls
        triggerType: 'health_scan',
        summary: cycleResult.summary,
        confidence: cycleResult.confidence,
      });
    } catch (err) {
      logger.error({ err, teamId }, 'Failed to persist investigation memory');
      // Don't fail the whole investigation if memory persistence fails
    }
  }

  /**
   * Best-effort extraction of structured findings from the evidence text.
   * The LLM doesn't output structured findings, so we parse from the
   * "EVIDENCE: tool → finding → verdict" format.
   */
  private extractFindingsFromText(
    evidence: string,
    verification: string,
  ): Array<{
    service: string;
    symptom: string;
    rootCause: string;
    confidence: 'high' | 'medium' | 'low';
    wasVerified: boolean;
  }> {
    const findings: Array<{
      service: string;
      symptom: string;
      rootCause: string;
      confidence: 'high' | 'medium' | 'low';
      wasVerified: boolean;
    }> = [];

    // Look for service names mentioned in the evidence
    const serviceMatches = evidence.match(
      /(?:service|ServiceName)[=:\s]+['"]?([\w-]+)/gi,
    );
    if (serviceMatches) {
      for (const match of serviceMatches) {
        const serviceName = match
          .split(/[:=\s]+/)
          .pop()
          ?.replace(/['"]/g, '');
        if (serviceName) {
          // Create a finding entry from context
          const symptomMatch = evidence.match(
            new RegExp(
              `${serviceName}[^\\n]{0,100}(spike|increase|degradation|error|slow|timeout|high)`,
              'i',
            ),
          );
          const symptom = symptomMatch
            ? symptomMatch[0]
            : 'Anomalous behavior detected';

          const rootCauseMatch = evidence.match(
            /(?:root cause|caused by|due to|because)[^.\n]{5,100}/i,
          );
          const rootCause = rootCauseMatch
            ? rootCauseMatch[0].trim()
            : 'Investigation required';

          const isVerified = verification.toLowerCase().includes('confirmed');

          findings.push({
            service: serviceName,
            symptom,
            rootCause,
            confidence: isVerified ? 'high' : 'medium',
            wasVerified: isVerified,
          });
        }
      }
    }

    // Deduplicate by service name
    const seen = new Set<string>();
    return findings.filter(f => {
      if (seen.has(f.service)) return false;
      seen.add(f.service);
      return true;
    });
  }

  /**
   * Extract created artifact IDs from the summary text.
   * Looks for patterns like "created saved search: <name> (ID: <id>)" etc.
   */
  private extractArtifactsFromSummary(summary: string): Array<{
    type: 'savedSearch' | 'dashboard' | 'alert';
    id: string;
    purpose: string;
  }> {
    const artifacts: Array<{
      type: 'savedSearch' | 'dashboard' | 'alert';
      id: string;
      purpose: string;
    }> = [];

    // Pattern: "created saved search: <name> (ID: <hex>)"
    const savedSearchPattern =
      /created saved search:\s*([^(]+)\(ID:\s*([a-f0-9]+)\)/gi;
    for (const match of summary.matchAll(savedSearchPattern)) {
      artifacts.push({
        type: 'savedSearch',
        id: match[2],
        purpose: match[1].trim(),
      });
    }

    // Pattern: "created dashboard: <name> (ID: <hex>)"
    const dashboardPattern =
      /created dashboard:\s*([^(]+)\(ID:\s*([a-f0-9]+)\)/gi;
    for (const match of summary.matchAll(dashboardPattern)) {
      artifacts.push({
        type: 'dashboard',
        id: match[2],
        purpose: match[1].trim(),
      });
    }

    // Pattern: "created alert: <name> (ID: <hex>)"
    const alertPattern = /created alert:\s*([^(]+)\(ID:\s*([a-f0-9]+)\)/gi;
    for (const match of summary.matchAll(alertPattern)) {
      artifacts.push({
        type: 'alert',
        id: match[2],
        purpose: match[1].trim(),
      });
    }

    return artifacts;
  }

  /**
   * Compute how many times this pattern has recurred by checking past memories
   * with matching service names.
   */
  private computeRecurrenceCount(
    findings: Array<{ service: string }>,
    teamId: string,
  ): number {
    if (findings.length === 0) return 0;
    const services = findings.map(f => f.service);
    return 0; // Will be computed from InvestigationMemory in a future enhancement
  }

  async asyncDispose(): Promise<void> {
    // No-op
  }
}

/**
 * Get the next phase label after the current one completes.
 */
function getNextPhase(phase: LoopPhase) {
  const order: LoopPhase[] = [
    'plan',
    'execute',
    'verify',
    'summarize',
    'complete',
  ];
  const idx = order.indexOf(phase);
  return order[Math.min(idx + 1, order.length - 1)];
}

/**
 * Build a phase history entry for the loopState.
 */
function getPhaseHistoryEntry(phase: LoopPhase, output: string) {
  return {
    phase,
    input: '',
    output,
    toolCalls: 0,
    completedAt: new Date(),
  };
}
