import User from '@/models/user';
import { CheckInactiveUsersTaskArgs, HdxTask } from '@/tasks/types';
import logger from '@/utils/logger';

const INACTIVITY_DAYS = 90;

export async function disableInactiveUsers(): Promise<number> {
  const cutoffDate = new Date(
    Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000,
  );

  const result = await User.updateMany(
    {
      lastLoginAt: { $lt: cutoffDate },
      disabledAt: null,
      isSuperAdmin: { $ne: true },
    },
    {
      $set: {
        disabledAt: new Date(),
        disabledReason: 'inactivity_90d',
      },
    },
  );

  return result.modifiedCount;
}

export default class CheckInactiveUsersTask
  implements HdxTask<CheckInactiveUsersTaskArgs>
{
  constructor(private args: CheckInactiveUsersTaskArgs) {}

  async execute(): Promise<void> {
    const count = await disableInactiveUsers();
    logger.info(
      `checkInactiveUsers: disabled ${count} user(s) inactive for ${INACTIVITY_DAYS}+ days`,
    );
  }

  name(): string {
    return this.args.taskName;
  }

  async asyncDispose(): Promise<void> {}
}
