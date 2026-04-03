import User from '@/models/user';
import logger from '@/utils/logger';

/**
 * One-time migration that backfills `lastLoginAt` from `updatedAt` for
 * existing users who don't have it set. This prevents mass-disabling
 * existing users when the inactive-user cron job first runs.
 *
 * Safe to run multiple times -- it only touches documents where
 * `lastLoginAt` does not yet exist.
 */
export async function backfillLastLoginAt(): Promise<number> {
  const result = await User.updateMany(
    { lastLoginAt: { $exists: false } },
    [
      {
        $set: {
          lastLoginAt: '$updatedAt',
          disabledAt: null,
          disabledReason: null,
        },
      },
    ],
  );

  logger.info(
    { modifiedCount: result.modifiedCount },
    'backfillLastLoginAt completed',
  );

  return result.modifiedCount;
}
