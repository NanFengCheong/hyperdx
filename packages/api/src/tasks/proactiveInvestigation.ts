import Connection from '@/models/connection';
import Investigation from '@/models/investigation';
import Team from '@/models/team';
import User from '@/models/user';
import {
  runInvestigationAgent,
} from '@/controllers/investigation-agent';
import {
  buildSchemaPrompt,
  fetchClickHouseSchema,
} from '@/controllers/investigation-tools/schema';
import { HdxTask, ProactiveInvestigationTaskArgs, TaskName } from '@/tasks/types';
import logger from '@/utils/logger';

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

    logger.info(`Starting proactive investigation for ${teams.length} teams`);

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
    // 1. Find a user to act as the "creator" (e.g., the first admin or any user)
    const user = await User.findOne({ team: teamId });
    if (!user) {
      logger.warn({ teamId }, 'No user found for team, skipping proactive investigation');
      return;
    }

    // 2. Find a connection
    const connection = await Connection.findOne({ team: teamId }).select('+password');
    if (!connection) {
      logger.warn({ teamId }, 'No connection found for team, skipping proactive investigation');
      return;
    }

    // 3. Fetch schema
    const schema = await fetchClickHouseSchema(teamId, connection._id.toString());
    const schemaPrompt = buildSchemaPrompt(schema);

    // 4. Build system prompt for proactive check
    const systemPrompt = `You are a proactive AI investigation agent for HyperDX. Your goal is to perform a health check of the system for the last 1 hour.
Look for:
- Spikes in error rates
- Latency regressions
- Failing critical traces
- Abnormal log patterns

If you find anything concerning, investigate further to find the root cause.
You have the ability to create saved searches and dashboards if you find patterns that should be monitored.

## Database Schema
${schemaPrompt}

## Guidelines
1. Use tools to query data for the last 1 hour.
2. Cite specific evidence for your findings.
3. If everything looks healthy, provide a brief "All Healthy" summary.
4. If issues are found, provide a detailed report and suggest next steps.
5. You can use createSavedSearch or createDashboard to help the team monitor the situation.`;

    const messages = [
      {
        role: 'user' as const,
        content: 'Perform a proactive health check of the system for the last 1 hour.',
      },
    ];

    logger.info({ teamId }, `Running proactive investigation agent for team ${teamId}`);

    // 5. Run agent
    const { text, toolCalls } = await runInvestigationAgent({
      messages,
      systemPrompt,
      connection: {
        host: connection.host,
        username: connection.username,
        password: connection.password,
      },
      teamId,
      userId: user._id.toString(),
    });

    // 6. Save investigation
    await Investigation.create({
      team: teamId,
      createdBy: user._id,
      title: `Proactive Health Check - ${new Date().toISOString()}`,
      status: 'active',
      entryPoint: { type: 'standalone' },
      messages: [
        {
          role: 'user',
          content: messages[0].content,
          timestamp: new Date(),
        },
        {
          role: 'assistant',
          content: text,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: new Date(),
        },
      ],
    });

    logger.info({ teamId }, `Proactive investigation completed for team ${teamId}`);
  }

  async asyncDispose(): Promise<void> {
    // No-op
  }
}
