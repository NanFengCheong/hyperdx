import mongoose from 'mongoose';

import { CLICKHOUSE_HOST } from '@/config';
import AuditLog from '@/models/auditLog';
import PlatformSetting from '@/models/platformSetting';
import { ClickhouseRetentionTaskArgs, HdxTask } from '@/tasks/types';
import logger from '@/utils/logger';

const DEFAULT_MAX_DISK_GB = 100;

/** All telemetry tables that use daily partitions (toDate) */
const TELEMETRY_TABLES = [
  'otel_logs',
  'otel_traces',
  'otel_metrics_gauge',
  'otel_metrics_sum',
  'otel_metrics_histogram',
  'otel_metrics_exponential_histogram',
  'otel_metrics_summary',
  'hyperdx_sessions',
];

interface PartitionInfo {
  table: string;
  partition: string; // e.g. '2026-04-01'
  sizeBytes: number;
}

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000000');
const SYSTEM_EMAIL = 'system@hyperdx.io';

async function writeAuditLog(
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await AuditLog.create({
      teamId: SYSTEM_ACTOR_ID,
      actorId: SYSTEM_ACTOR_ID,
      actorEmail: SYSTEM_EMAIL,
      action,
      targetType: 'ClickHouse',
      targetId: 'clickhouse-retention',
      details,
    });
  } catch (error) {
    logger.error(
      { error, action },
      'Failed to write audit log for ClickHouse retention task',
    );
  }
}

async function getSettings(): Promise<{ maxDiskGB: number; enabled: boolean }> {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'clickhouseRetention',
    });
    const value = setting?.value as
      | { maxDiskGB?: number; enabled?: boolean }
      | undefined;
    return {
      maxDiskGB: value?.maxDiskGB ?? DEFAULT_MAX_DISK_GB,
      enabled: value?.enabled ?? true,
    };
  } catch (error) {
    logger.warn(
      { error },
      'Failed to read ClickHouse retention settings, using defaults',
    );
    return { maxDiskGB: DEFAULT_MAX_DISK_GB, enabled: true };
  }
}

/**
 * Query ClickHouse system.parts for partition sizes across telemetry tables.
 * Uses the HTTP interface directly since we only need simple queries.
 */
async function queryClickhouse(query: string): Promise<string> {
  const url = new URL(CLICKHOUSE_HOST);
  url.searchParams.set('query', query);
  const resp = await fetch(url.toString());
  if (!resp.ok) {
    throw new Error(
      `ClickHouse query failed: ${resp.status} ${await resp.text()}`,
    );
  }
  return resp.text();
}

/** Get total disk usage in bytes for telemetry tables */
async function getTotalDiskUsage(): Promise<number> {
  const tableList = TELEMETRY_TABLES.map(t => `'${t}'`).join(',');
  const result = await queryClickhouse(
    `SELECT sum(bytes_on_disk) as total FROM system.parts WHERE active = 1 AND table IN (${tableList}) FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  return Number(parsed.data?.[0]?.total ?? 0);
}

/** Get partition info ordered by partition date (oldest first) */
async function getPartitionsByAge(): Promise<PartitionInfo[]> {
  const tableList = TELEMETRY_TABLES.map(t => `'${t}'`).join(',');
  const result = await queryClickhouse(
    `SELECT table, partition, sum(bytes_on_disk) as sizeBytes
     FROM system.parts
     WHERE active = 1 AND table IN (${tableList})
     GROUP BY table, partition
     ORDER BY partition ASC, table ASC
     FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  return (parsed.data ?? []).map((row: any) => ({
    table: row.table,
    partition: row.partition,
    sizeBytes: Number(row.sizeBytes),
  }));
}

/** Drop a specific partition from a table */
async function dropPartition(table: string, partition: string): Promise<void> {
  await queryClickhouse(`ALTER TABLE ${table} DROP PARTITION '${partition}'`);
}

export default class ClickhouseRetentionTask
  implements HdxTask<ClickhouseRetentionTaskArgs>
{
  constructor(private args: ClickhouseRetentionTaskArgs) {}

  async execute(): Promise<void> {
    const { dryRun } = this.args;
    const settings = await getSettings();

    if (!settings.enabled) {
      logger.info('clickhouseRetention: Disabled via settings, skipping');
      return;
    }

    const maxBytes = settings.maxDiskGB * 1024 * 1024 * 1024;
    const totalBefore = await getTotalDiskUsage();
    const totalBeforeGB = (totalBefore / (1024 * 1024 * 1024)).toFixed(2);

    logger.info(
      `clickhouseRetention: Current disk usage ${totalBeforeGB} GB, limit ${settings.maxDiskGB} GB${dryRun ? ' [DRY RUN]' : ''}`,
    );

    if (totalBefore <= maxBytes) {
      logger.info('clickhouseRetention: Under limit, no cleanup needed');
      await writeAuditLog('clickhouse_retention.check', {
        diskUsageGB: totalBeforeGB,
        maxDiskGB: settings.maxDiskGB,
        action: 'no_cleanup_needed',
        dryRun,
      });
      return;
    }

    // Get all partitions ordered oldest first
    const partitions = await getPartitionsByAge();
    const dropped: { table: string; partition: string; sizeBytes: number }[] =
      [];
    let currentUsage = totalBefore;

    // Group partitions by date so we drop all tables for same date together
    const partitionsByDate = new Map<string, PartitionInfo[]>();
    for (const p of partitions) {
      const existing = partitionsByDate.get(p.partition) ?? [];
      existing.push(p);
      partitionsByDate.set(p.partition, existing);
    }

    // Iterate dates oldest first
    for (const [date, datePartitions] of partitionsByDate) {
      if (currentUsage <= maxBytes) break;

      for (const p of datePartitions) {
        if (dryRun) {
          logger.info(
            `[DRY RUN] Would drop partition ${p.partition} from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
        } else {
          logger.info(
            `clickhouseRetention: Dropping partition ${p.partition} from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          await dropPartition(p.table, p.partition);
        }
        dropped.push({
          table: p.table,
          partition: p.partition,
          sizeBytes: p.sizeBytes,
        });
        currentUsage -= p.sizeBytes;
      }
    }

    const totalAfterGB = (currentUsage / (1024 * 1024 * 1024)).toFixed(2);
    const freedGB = (
      (totalBefore - currentUsage) /
      (1024 * 1024 * 1024)
    ).toFixed(2);

    logger.info(
      `clickhouseRetention: ${dryRun ? '[DRY RUN] Would drop' : 'Dropped'} ${dropped.length} partition(s), freed ${freedGB} GB. Usage: ${totalBeforeGB} GB → ${totalAfterGB} GB`,
    );

    await writeAuditLog(
      dryRun
        ? 'clickhouse_retention.cleanup_dry_run'
        : 'clickhouse_retention.cleanup',
      {
        diskUsageBeforeGB: totalBeforeGB,
        diskUsageAfterGB: totalAfterGB,
        freedGB,
        maxDiskGB: settings.maxDiskGB,
        partitionsDropped: dropped.length,
        dropped: dropped.map(d => ({
          table: d.table,
          partition: d.partition,
          sizeMB: (d.sizeBytes / (1024 * 1024)).toFixed(1),
        })),
        dryRun,
      },
    );
  }

  name(): string {
    return this.args.taskName;
  }

  async asyncDispose(): Promise<void> {}
}
