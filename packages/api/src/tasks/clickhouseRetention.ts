import mongoose from 'mongoose';

import {
  CLICKHOUSE_ENDPOINT,
  CLICKHOUSE_HOST,
  CLICKHOUSE_PASSWORD,
  CLICKHOUSE_USER,
  DEFAULT_CONNECTIONS,
} from '@/config';
import AuditLog from '@/models/auditLog';
import PlatformSetting from '@/models/platformSetting';
import { ClickhouseRetentionTaskArgs, HdxTask } from '@/tasks/types';
import logger from '@/utils/logger';

export const DEFAULT_MAX_DISK_GB = 100;
export const TARGET_USAGE_PERCENT = 80;
export const TARGET_USAGE_RATIO = TARGET_USAGE_PERCENT / 100;

interface PartitionInfo {
  database: string;
  table: string;
  partition: string;
  partitionId: string;
  oldestDateTime: string;
  sizeBytes: number;
}

export interface ClickHouseTableDiskUsage {
  database: string;
  table: string;
  sizeGB: string;
  oldestPartition: string | null;
  newestPartition: string | null;
  partitionCount: number;
}

export interface ClickHouseRetentionStatus {
  diskSizeGB: string;
  totalSizeGB: string;
  freeDiskGB: string;
  maxDiskGB: number;
  enabled: boolean;
  usagePercent: string;
  targetUsagePercent: number;
  thresholdGB: string;
  isOverThreshold: boolean;
  tables: ClickHouseTableDiskUsage[];
}

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000000');
const SYSTEM_EMAIL = 'system@hyperdx.io';
const USER_DATABASE_FILTER =
  "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";
const DROPPABLE_PARTITION_FILTER =
  "partition != 'tuple()' AND partition_id != 'all'";

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

type ClickHouseConnection = {
  host: string;
  username?: string;
  password?: string;
};

function getDefaultConnection(): ClickHouseConnection | undefined {
  if (!DEFAULT_CONNECTIONS) {
    return undefined;
  }

  try {
    const connections = JSON.parse(DEFAULT_CONNECTIONS);
    const connection = Array.isArray(connections) ? connections[0] : undefined;
    if (connection?.host) {
      return {
        host: connection.host,
        username: connection.username,
        password: connection.password,
      };
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to parse DEFAULT_CONNECTIONS');
  }

  return undefined;
}

function endpointToHttpHost(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }

  try {
    const url = new URL(endpoint);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return endpoint;
    }

    if (url.protocol === 'tcp:') {
      return `http://${url.hostname}:8123`;
    }
  } catch (error) {
    logger.warn({ error, endpoint }, 'Failed to parse CLICKHOUSE_ENDPOINT');
  }

  return undefined;
}

function getClickHouseConnection(): ClickHouseConnection {
  if (CLICKHOUSE_HOST) {
    return {
      host: CLICKHOUSE_HOST,
      username: CLICKHOUSE_USER,
      password: CLICKHOUSE_PASSWORD,
    };
  }

  const defaultConnection = getDefaultConnection();
  if (defaultConnection) {
    return defaultConnection;
  }

  const endpointHost = endpointToHttpHost(CLICKHOUSE_ENDPOINT);
  if (endpointHost) {
    return {
      host: endpointHost,
      username: CLICKHOUSE_USER,
      password: CLICKHOUSE_PASSWORD,
    };
  }

  throw new Error(
    'ClickHouse HTTP host is not configured. Set CLICKHOUSE_HOST or DEFAULT_CONNECTIONS.',
  );
}

export function quoteClickHouseIdentifier(identifier: string): string {
  return '`' + identifier.replaceAll('`', '``') + '`';
}

export async function queryClickhouse(query: string): Promise<string> {
  const connection = getClickHouseConnection();
  const url = new URL(connection.host);
  url.searchParams.set('query', query);
  const headers: Record<string, string> = {};

  if (connection.username) {
    headers.Authorization = `Basic ${Buffer.from(
      `${connection.username}:${connection.password ?? ''}`,
    ).toString('base64')}`;
  }

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    throw new Error(
      `ClickHouse query failed: ${resp.status} ${await resp.text()}`,
    );
  }
  return resp.text();
}

/** Get total disk usage in bytes for all user ClickHouse tables */
async function getTotalDiskUsage(): Promise<number> {
  const result = await queryClickhouse(
    `SELECT sum(bytes_on_disk) as total FROM system.parts WHERE active = 1 AND ${USER_DATABASE_FILTER} FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  return Number(parsed.data?.[0]?.total ?? 0);
}

export async function getTableDiskUsage(): Promise<ClickHouseTableDiskUsage[]> {
  const result = await queryClickhouse(
    `SELECT database, table, sum(bytes_on_disk) as bytes, min(partition) as oldest_partition, max(partition) as newest_partition, uniqExactIf(partition, ${DROPPABLE_PARTITION_FILTER}) as partition_count
     FROM system.parts
     WHERE active = 1 AND ${USER_DATABASE_FILTER}
     GROUP BY database, table
     ORDER BY sum(bytes_on_disk) DESC
     FORMAT JSON`,
  );
  const parsed = JSON.parse(result);

  return (parsed.data ?? []).map((row: any) => ({
    database: row.database,
    table: row.table,
    sizeGB: (Number(row.bytes) / (1024 * 1024 * 1024)).toFixed(2),
    oldestPartition: row.oldest_partition,
    newestPartition: row.newest_partition,
    partitionCount: Number(row.partition_count),
  }));
}

export async function getClickHouseRetentionStatus(
  maxDiskGB: number,
  enabled: boolean,
): Promise<ClickHouseRetentionStatus> {
  const [tableStats, totalBytes] = await Promise.all([
    getTableDiskUsage(),
    getTotalDiskUsage(),
  ]);
  const diskSizeBytes = maxDiskGB * 1024 * 1024 * 1024;
  const freeBytes = Math.max(0, diskSizeBytes - totalBytes);
  const thresholdBytes = diskSizeBytes * TARGET_USAGE_RATIO;

  return {
    diskSizeGB: maxDiskGB.toFixed(2),
    totalSizeGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(2),
    freeDiskGB: (freeBytes / (1024 * 1024 * 1024)).toFixed(2),
    maxDiskGB,
    enabled,
    usagePercent: ((totalBytes / diskSizeBytes) * 100).toFixed(1),
    targetUsagePercent: TARGET_USAGE_PERCENT,
    thresholdGB: (thresholdBytes / (1024 * 1024 * 1024)).toFixed(2),
    isOverThreshold: totalBytes > thresholdBytes,
    tables: tableStats,
  };
}

/** Get partition info ordered by partition date (oldest first) */
async function getPartitionsByAge(): Promise<PartitionInfo[]> {
  const result = await queryClickhouse(
    `SELECT database, table, partition, partition_id as partitionId, toString(min(if(min_time = toDateTime(0), toDateTime(min_date), min_time))) as oldestDateTime, sum(bytes_on_disk) as sizeBytes
     FROM system.parts
     WHERE active = 1 AND ${USER_DATABASE_FILTER} AND ${DROPPABLE_PARTITION_FILTER}
     GROUP BY database, table, partition, partition_id
     ORDER BY oldestDateTime ASC, database ASC, table ASC
     FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  return (parsed.data ?? []).map((row: any) => ({
    database: row.database,
    table: row.table,
    partition: row.partition,
    partitionId: row.partitionId,
    oldestDateTime: row.oldestDateTime,
    sizeBytes: Number(row.sizeBytes),
  }));
}

/** Drop a specific partition from a table */
async function dropPartition(
  database: string,
  table: string,
  partitionId: string,
): Promise<void> {
  const escapedPartitionId = partitionId.replaceAll("'", "\\'");
  await queryClickhouse(
    `ALTER TABLE ${quoteClickHouseIdentifier(database)}.${quoteClickHouseIdentifier(table)} DROP PARTITION ID '${escapedPartitionId}'`,
  );
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

    const diskSizeBytes = settings.maxDiskGB * 1024 * 1024 * 1024;
    const maxBytes = diskSizeBytes * TARGET_USAGE_RATIO;
    const totalBefore = await getTotalDiskUsage();
    const totalBeforeGB = (totalBefore / (1024 * 1024 * 1024)).toFixed(2);
    const freeBeforeGB = (
      Math.max(0, diskSizeBytes - totalBefore) /
      (1024 * 1024 * 1024)
    ).toFixed(2);

    logger.info(
      `clickhouseRetention: Current disk usage ${totalBeforeGB} GB, free ${freeBeforeGB} GB, cleanup threshold ${TARGET_USAGE_PERCENT}% of ${settings.maxDiskGB} GB${dryRun ? ' [DRY RUN]' : ''}`,
    );

    if (totalBefore <= maxBytes) {
      logger.info(
        'clickhouseRetention: Under 80% threshold, no cleanup needed',
      );
      await writeAuditLog('clickhouse_retention.check', {
        diskUsageGB: totalBeforeGB,
        freeDiskGB: freeBeforeGB,
        maxDiskGB: settings.maxDiskGB,
        targetUsagePercent: TARGET_USAGE_PERCENT,
        action: 'no_cleanup_needed',
        dryRun,
      });
      return;
    }

    // Get all partitions ordered oldest first
    const partitions = await getPartitionsByAge();
    const dropped: {
      database: string;
      table: string;
      partition: string;
      partitionId: string;
      oldestDateTime: string;
      sizeBytes: number;
    }[] = [];
    let currentUsage = totalBefore;

    // Group partitions by oldest part datetime so tables for the same time slice are dropped together.
    const partitionsByDateTime = new Map<string, PartitionInfo[]>();
    for (const p of partitions) {
      const existing = partitionsByDateTime.get(p.oldestDateTime) ?? [];
      existing.push(p);
      partitionsByDateTime.set(p.oldestDateTime, existing);
    }

    // Iterate datetimes oldest first
    for (const datePartitions of partitionsByDateTime.values()) {
      if (currentUsage <= maxBytes) break;

      for (const p of datePartitions) {
        if (dryRun) {
          logger.info(
            `[DRY RUN] Would drop partition ${p.partition} (${p.oldestDateTime}) from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
        } else {
          logger.info(
            `clickhouseRetention: Dropping partition ${p.partition} (${p.partitionId}, ${p.oldestDateTime}) from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          await dropPartition(p.database, p.table, p.partitionId);
        }
        dropped.push({
          database: p.database,
          table: p.table,
          partition: p.partition,
          partitionId: p.partitionId,
          oldestDateTime: p.oldestDateTime,
          sizeBytes: p.sizeBytes,
        });
        currentUsage -= p.sizeBytes;
      }
    }

    const totalAfterGB = (currentUsage / (1024 * 1024 * 1024)).toFixed(2);
    const freeAfterGB = (
      Math.max(0, diskSizeBytes - currentUsage) /
      (1024 * 1024 * 1024)
    ).toFixed(2);
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
        freeDiskBeforeGB: freeBeforeGB,
        freeDiskAfterGB: freeAfterGB,
        freedGB,
        maxDiskGB: settings.maxDiskGB,
        targetUsagePercent: TARGET_USAGE_PERCENT,
        partitionsDropped: dropped.length,
        dropped: dropped.map(d => ({
          database: d.database,
          table: d.table,
          partition: d.partition,
          partitionId: d.partitionId,
          oldestDateTime: d.oldestDateTime,
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
