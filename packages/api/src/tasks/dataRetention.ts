import {
  RETENTION_DAYS_AUDITLOG,
  RETENTION_DAYS_ALERTHISTORY,
} from '@/config';
import AuditLog from '@/models/auditLog';
import { DataRetentionTaskArgs, HdxTask } from '@/tasks/types';
import logger from '@/utils/logger';
import mongoose from 'mongoose';
import PlatformSetting from '@/models/platformSetting';

/**
 * Default retention periods (in days) for MongoDB collections.
 * Configuration is loaded from environment variables via config.ts.
 */
const DEFAULT_RETENTION_DAYS: Record<string, number> = {
  AuditLog: RETENTION_DAYS_AUDITLOG,
  AlertHistory: RETENTION_DAYS_ALERTHISTORY,
};

/**
 * Returns the configured retention days for a collection.
 * Reads from PlatformSetting DB first, falls back to env vars in config.ts.
 */
async function getRetentionDays(collectionName: string): Promise<number> {
  try {
    const setting = await PlatformSetting.findOne({ key: 'dataRetention' });
    const value = setting?.value as Record<string, number> | undefined;
    const keyMap: Record<string, string> = {
      AuditLog: 'auditLog',
      AlertHistory: 'alertHistory',
    };
    const dbKey = keyMap[collectionName];
    if (dbKey && value?.[dbKey] != null) {
      return value[dbKey];
    }
  } catch (error) {
    logger.warn({ error, collectionName }, 'Failed to read retention settings from DB, using env defaults');
  }
  return DEFAULT_RETENTION_DAYS[collectionName] ?? 0;
}

export interface RetentionPolicy {
  collectionName: string;
  retentionDays: number;
  deletedCount: number;
  dryRun: boolean;
}

/** System user ID for automated tasks (sentinel value) */
const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000000');
const SYSTEM_EMAIL = 'system@hyperdx.io';

async function writeAuditLog(
  action: string,
  targetType: string,
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await AuditLog.create({
      teamId: SYSTEM_ACTOR_ID,
      actorId: SYSTEM_ACTOR_ID,
      actorEmail: SYSTEM_EMAIL,
      action,
      targetType,
      targetId,
      details,
    });
  } catch (error) {
    logger.error({ error, action }, 'Failed to write audit log for data retention task');
  }
}

/**
 * Deletes documents older than the retention period for a given collection.
 * Returns the number of documents that would be/were deleted.
 */
export async function applyRetention(
  collectionName: string,
  retentionDays: number,
  dryRun: boolean,
): Promise<number> {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  let model: typeof AuditLog;
  switch (collectionName) {
    case 'AuditLog':
      model = AuditLog;
      break;
    default:
      logger.warn(`Unknown collection: ${collectionName}, skipping`);
      return 0;
  }

  const count = await model.countDocuments({
    createdAt: { $lt: cutoffDate },
  });

  if (count === 0) {
    logger.info(`${collectionName}: No documents older than ${retentionDays} days`);
    return 0;
  }

  if (dryRun) {
    logger.info(
      `[DRY RUN] ${collectionName}: Would delete ${count} document(s) older than ${retentionDays} days (before ${cutoffDate.toISOString()})`,
    );
    return count;
  }

  const result = await model.deleteMany({
    createdAt: { $lt: cutoffDate },
  });

  logger.info(
    `${collectionName}: Deleted ${result.deletedCount} document(s) older than ${retentionDays} days (before ${cutoffDate.toISOString()})`,
  );

  return result.deletedCount;
}

export default class DataRetentionTask
  implements HdxTask<DataRetentionTaskArgs>
{
  constructor(private args: DataRetentionTaskArgs) {}

  async execute(): Promise<void> {
    const { dryRun } = this.args;
    const results: RetentionPolicy[] = [];
    const startTime = new Date();

    logger.info(
      `dataRetention: Starting ${dryRun ? '[DRY RUN] ' : ''}data retention cleanup`,
    );

    for (const collectionName of Object.keys(DEFAULT_RETENTION_DAYS)) {
      const retentionDays = await getRetentionDays(collectionName);
      if (retentionDays === 0) {
        logger.info(`${collectionName}: No retention policy configured, skipping`);
        continue;
      }

      try {
        const deletedCount = await applyRetention(
          collectionName,
          retentionDays,
          dryRun,
        );

        results.push({
          collectionName,
          retentionDays,
          deletedCount,
          dryRun,
        });

        // Write per-collection audit log
        await writeAuditLog(
          dryRun ? 'data_retention.dry_run' : 'data_retention.cleanup',
          collectionName,
          `${collectionName}`,
          {
            retentionDays,
            deletedCount,
            dryRun,
            retentionCutoff: new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString(),
          },
        );
      } catch (error) {
        logger.error(
          { error, collectionName },
          `dataRetention: Failed to process ${collectionName}`,
        );

        // Write error audit log
        await writeAuditLog(
          'data_retention.error',
          collectionName,
          `${collectionName}`,
          {
            retentionDays,
            dryRun,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }

    // Summary
    const totalDeleted = results.reduce((sum, r) => sum + r.deletedCount, 0);
    const durationMs = Date.now() - startTime.getTime();

    logger.info(
      `dataRetention: Complete. Processed ${results.length} collection(s), ${dryRun ? 'would delete' : 'deleted'} ${totalDeleted} document(s) total`,
    );

    // Write summary audit log
    await writeAuditLog(
      dryRun ? 'data_retention.summary_dry_run' : 'data_retention.summary',
      'DataRetentionTask',
      'data-retention',
      {
        collectionsProcessed: results.length,
        totalDeleted,
        durationMs,
        dryRun,
        startTime: startTime.toISOString(),
        endTime: new Date().toISOString(),
        results: results.map(r => ({
          collection: r.collectionName,
          retentionDays: r.retentionDays,
          deletedCount: r.deletedCount,
        })),
      },
    );
  }

  name(): string {
    return this.args.taskName;
  }

  async asyncDispose(): Promise<void> {}
}
