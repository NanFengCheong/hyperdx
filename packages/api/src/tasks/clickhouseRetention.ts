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

export const TARGET_USAGE_PERCENT = 90;

interface PartitionInfo {
  database: string;
  table: string;
  partition: string;
  partitionId: string;
  oldestDateTime: string;
  sizeBytes: number;
}

interface DetachedPartInfo {
  database: string;
  table: string;
  partition: string;
  partitionId: string;
  name: string;
  sizeBytes: number;
}

interface SystemLogTableInfo {
  table: string;
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

export interface ClickHouseStorageBreakdown {
  activePartsGB: string;
  inactivePartsGB: string;
  detachedPartsGB: string;
  otherFilesystemGB: string;
}

export interface ClickHouseRetentionStatus {
  diskSizeGB: string;
  totalSizeGB: string;
  freeDiskGB: string;
  enabled: boolean;
  usagePercent: string;
  targetUsagePercent: number;
  thresholdGB: string;
  isOverThreshold: boolean;
  storageBreakdown: ClickHouseStorageBreakdown;
  tables: ClickHouseTableDiskUsage[];
}

interface ClickHouseDiskUsage {
  usedBytes: number;
  freeBytes: number;
  totalBytes: number;
}

const SYSTEM_ACTOR_ID = new mongoose.Types.ObjectId('000000000000000000000000');
const SYSTEM_EMAIL = 'system@hyperdx.io';
const USER_DATABASE_FILTER =
  "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";
const CLEANABLE_SYSTEM_LOG_TABLES = [
  'asynchronous_metric_log',
  'crash_log',
  'error_log',
  'metric_log',
  'opentelemetry_span_log',
  'part_log',
  'processors_profile_log',
  'query_log',
  'query_thread_log',
  'text_log',
  'trace_log',
];
const CLEANABLE_SYSTEM_LOG_TABLE_LIST = CLEANABLE_SYSTEM_LOG_TABLES.map(
  table => `'${table}'`,
).join(',');
const CLEANABLE_PARTS_FILTER = `(${USER_DATABASE_FILTER} OR (database = 'system' AND table IN (${CLEANABLE_SYSTEM_LOG_TABLE_LIST})))`;
const DROPPABLE_PARTITION_FILTER =
  "partition != 'tuple()' AND partition_id != 'all'";
const BYTES_IN_GB = 1024 * 1024 * 1024;

function formatGB(bytes: number): string {
  return (bytes / BYTES_IN_GB).toFixed(2);
}

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

async function getSettings(): Promise<{
  enabled: boolean;
  targetUsagePercent: number;
}> {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'clickhouseRetention',
    });
    const value = setting?.value as
      | { enabled?: boolean; targetUsagePercent?: number }
      | undefined;
    return {
      enabled: value?.enabled ?? true,
      targetUsagePercent: value?.targetUsagePercent ?? TARGET_USAGE_PERCENT,
    };
  } catch (error) {
    logger.warn(
      { error },
      'Failed to read ClickHouse retention settings, using defaults',
    );
    return {
      enabled: true,
      targetUsagePercent: TARGET_USAGE_PERCENT,
    };
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
  const headers: Record<string, string> = {};

  if (connection.username) {
    headers.Authorization = `Basic ${Buffer.from(
      `${connection.username}:${connection.password ?? ''}`,
    ).toString('base64')}`;
  }

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: query,
  });
  if (!resp.ok) {
    throw new Error(
      `ClickHouse query failed: ${resp.status} ${await resp.text()}`,
    );
  }
  return resp.text();
}

/** Get filesystem disk usage in bytes for ClickHouse disks */
async function getFilesystemDiskUsage(): Promise<ClickHouseDiskUsage> {
  const result = await queryClickhouse(
    `SELECT sum(total_space) as total, sum(total_space - free_space) as used, sum(free_space) as free FROM system.disks FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  const usedBytes = Number(parsed.data?.[0]?.used ?? 0);
  const freeBytes = Number(parsed.data?.[0]?.free ?? 0);
  const totalBytes = Number(parsed.data?.[0]?.total ?? 0);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new Error('ClickHouse system.disks returned no disk total_space');
  }
  return {
    usedBytes,
    freeBytes,
    totalBytes,
  };
}

async function getClickHouseDiskUsage(): Promise<ClickHouseDiskUsage> {
  return getFilesystemDiskUsage();
}

async function getPartsUsageByState(): Promise<{
  activeBytes: number;
  inactiveBytes: number;
}> {
  const result = await queryClickhouse(
    `SELECT active, sum(bytes_on_disk) as bytes
     FROM system.parts
     WHERE ${CLEANABLE_PARTS_FILTER}
     GROUP BY active
     FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  let activeBytes = 0;
  let inactiveBytes = 0;

  for (const row of parsed.data ?? []) {
    if (Number(row.active) === 1) {
      activeBytes += Number(row.bytes);
    } else {
      inactiveBytes += Number(row.bytes);
    }
  }

  return { activeBytes, inactiveBytes };
}

async function getDetachedPartsUsage(): Promise<number> {
  try {
    const result = await queryClickhouse(
      `SELECT sum(bytes_on_disk) as bytes
       FROM system.detached_parts
       WHERE ${CLEANABLE_PARTS_FILTER}
       FORMAT JSON`,
    );
    const parsed = JSON.parse(result);
    return Number(parsed.data?.[0]?.bytes ?? 0);
  } catch (error) {
    logger.warn(
      { error },
      'Failed to read ClickHouse detached parts usage from system.detached_parts',
    );
    return 0;
  }
}

export async function getTableDiskUsage(): Promise<ClickHouseTableDiskUsage[]> {
  const result = await queryClickhouse(
    `SELECT database, table, sum(bytes_on_disk) as bytes, min(partition) as oldest_partition, max(partition) as newest_partition, uniqExactIf(partition, ${DROPPABLE_PARTITION_FILTER}) as partition_count
     FROM system.parts
     WHERE active = 1 AND ${CLEANABLE_PARTS_FILTER}
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
  enabled: boolean,
  targetUsagePercent: number = TARGET_USAGE_PERCENT,
): Promise<ClickHouseRetentionStatus> {
  const [tableStats, diskUsage, partsUsage, detachedPartsBytes] =
    await Promise.all([
      getTableDiskUsage(),
      getClickHouseDiskUsage(),
      getPartsUsageByState(),
      getDetachedPartsUsage(),
    ]);
  const totalBytes = diskUsage.usedBytes;
  const diskSizeBytes = diskUsage.totalBytes;
  const thresholdBytes = diskSizeBytes * (targetUsagePercent / 100);
  const otherFilesystemBytes = Math.max(
    0,
    totalBytes -
      partsUsage.activeBytes -
      partsUsage.inactiveBytes -
      detachedPartsBytes,
  );

  return {
    diskSizeGB: formatGB(diskSizeBytes),
    totalSizeGB: formatGB(totalBytes),
    freeDiskGB: formatGB(diskUsage.freeBytes),
    enabled,
    usagePercent:
      diskSizeBytes > 0
        ? ((totalBytes / diskSizeBytes) * 100).toFixed(1)
        : '0.0',
    targetUsagePercent,
    thresholdGB: formatGB(thresholdBytes),
    isOverThreshold: totalBytes > thresholdBytes,
    storageBreakdown: {
      activePartsGB: formatGB(partsUsage.activeBytes),
      inactivePartsGB: formatGB(partsUsage.inactiveBytes),
      detachedPartsGB: formatGB(detachedPartsBytes),
      otherFilesystemGB: formatGB(otherFilesystemBytes),
    },
    tables: tableStats,
  };
}

/** Get partition info ordered by partition date (oldest first) */
async function getPartitionsByAge(): Promise<PartitionInfo[]> {
  const result = await queryClickhouse(
    `SELECT database, table, partition, partition_id as partitionId, toString(min(min_time)) as oldestDateTime, sum(bytes_on_disk) as sizeBytes
     FROM system.parts
     WHERE active = 1 AND ${CLEANABLE_PARTS_FILTER} AND ${DROPPABLE_PARTITION_FILTER}
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

async function getDetachedPartsByAge(): Promise<DetachedPartInfo[]> {
  try {
    const result = await queryClickhouse(
      `SELECT database, table, partition, partition_id as partitionId, name, bytes_on_disk as sizeBytes
       FROM system.detached_parts
       WHERE ${CLEANABLE_PARTS_FILTER}
       ORDER BY partition ASC, database ASC, table ASC, name ASC
       FORMAT JSON`,
    );
    const parsed = JSON.parse(result);
    return (parsed.data ?? []).map((row: any) => ({
      database: row.database,
      table: row.table,
      partition: row.partition,
      partitionId: row.partitionId,
      name: row.name,
      sizeBytes: Number(row.sizeBytes),
    }));
  } catch (error) {
    logger.warn(
      { error },
      'Failed to list ClickHouse detached parts from system.detached_parts',
    );
    return [];
  }
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

async function dropDetachedPart(
  database: string,
  table: string,
  name: string,
): Promise<void> {
  const escapedName = name.replaceAll("'", "\\'");
  await queryClickhouse(
    `ALTER TABLE ${quoteClickHouseIdentifier(database)}.${quoteClickHouseIdentifier(table)} DROP DETACHED PART '${escapedName}'`,
  );
}

async function getSystemLogTablesBySize(): Promise<SystemLogTableInfo[]> {
  const result = await queryClickhouse(
    `SELECT table, sum(bytes_on_disk) as sizeBytes
     FROM system.parts
     WHERE active = 1 AND database = 'system' AND table IN (${CLEANABLE_SYSTEM_LOG_TABLE_LIST})
     GROUP BY table
     ORDER BY sizeBytes DESC
     FORMAT JSON`,
  );
  const parsed = JSON.parse(result);
  return (parsed.data ?? []).map((row: any) => ({
    table: row.table,
    sizeBytes: Number(row.sizeBytes),
  }));
}

async function truncateSystemLogTable(table: string): Promise<void> {
  await queryClickhouse(
    `TRUNCATE TABLE ${quoteClickHouseIdentifier('system')}.${quoteClickHouseIdentifier(table)}`,
  );
}

export default class ClickhouseRetentionTask
  implements HdxTask<ClickhouseRetentionTaskArgs>
{
  constructor(private args: ClickhouseRetentionTaskArgs) {}

  async execute(): Promise<void> {
    const { dryRun, nuke = false, force = false } = this.args;
    const settings = await getSettings();

    if (!settings.enabled && !nuke) {
      logger.info('clickhouseRetention: Disabled via settings, skipping');
      return;
    }

    const diskUsageBefore = await getClickHouseDiskUsage();
    const diskSizeBytes = diskUsageBefore.totalBytes;
    const maxBytes = diskSizeBytes * (settings.targetUsagePercent / 100);
    const totalBefore = diskUsageBefore.usedBytes;
    const diskSizeGB = formatGB(diskSizeBytes);
    const totalBeforeGB = formatGB(totalBefore);
    const freeBeforeGB = formatGB(diskUsageBefore.freeBytes);

    logger.info(
      `clickhouseRetention: Current disk usage ${totalBeforeGB} GB, free ${freeBeforeGB} GB, cleanup threshold ${settings.targetUsagePercent}% of ${diskSizeGB} GB${nuke ? ' [NUKE]' : ''}${force ? ' [FORCE]' : ''}${dryRun ? ' [DRY RUN]' : ''}`,
    );

    if (!nuke && !force && totalBefore <= maxBytes) {
      logger.info(
        `clickhouseRetention: Under ${settings.targetUsagePercent}% threshold, no cleanup needed`,
      );
      await writeAuditLog('clickhouse_retention.check', {
        diskUsageGB: totalBeforeGB,
        diskSizeGB,
        freeDiskGB: freeBeforeGB,
        targetUsagePercent: settings.targetUsagePercent,
        action: 'no_cleanup_needed',
        dryRun,
        nuke,
        force,
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
    const failed: {
      database: string;
      table: string;
      partition: string;
      partitionId: string;
      oldestDateTime: string;
      error: string;
    }[] = [];
    const detachedDropped: {
      database: string;
      table: string;
      partition: string;
      partitionId: string;
      name: string;
      sizeBytes: number;
    }[] = [];
    const detachedFailed: {
      database: string;
      table: string;
      partition: string;
      partitionId: string;
      name: string;
      error: string;
    }[] = [];
    const systemLogsTruncated: {
      table: string;
      sizeBytes: number;
    }[] = [];
    const systemLogsFailed: {
      table: string;
      error: string;
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
      if (!nuke && currentUsage <= maxBytes) break;

      for (const p of datePartitions) {
        if (dryRun) {
          logger.info(
            `[DRY RUN] Would drop partition ${p.partition} (${p.oldestDateTime}) from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          dropped.push({
            database: p.database,
            table: p.table,
            partition: p.partition,
            partitionId: p.partitionId,
            oldestDateTime: p.oldestDateTime,
            sizeBytes: p.sizeBytes,
          });
          currentUsage -= p.sizeBytes;
        } else {
          logger.info(
            `clickhouseRetention: Dropping partition ${p.partition} (${p.partitionId}, ${p.oldestDateTime}) from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          try {
            await dropPartition(p.database, p.table, p.partitionId);
            dropped.push({
              database: p.database,
              table: p.table,
              partition: p.partition,
              partitionId: p.partitionId,
              oldestDateTime: p.oldestDateTime,
              sizeBytes: p.sizeBytes,
            });
            currentUsage -= p.sizeBytes;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error(
              { error, partition: p },
              'clickhouseRetention: Failed to drop partition, continuing',
            );
            failed.push({
              database: p.database,
              table: p.table,
              partition: p.partition,
              partitionId: p.partitionId,
              oldestDateTime: p.oldestDateTime,
              error: message,
            });
          }
        }
      }
    }

    if (nuke || currentUsage > maxBytes) {
      const detachedParts = await getDetachedPartsByAge();

      for (const p of detachedParts) {
        if (!nuke && currentUsage <= maxBytes) break;

        if (dryRun) {
          logger.info(
            `[DRY RUN] Would drop detached part ${p.name} (${p.partition}) from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          detachedDropped.push({
            database: p.database,
            table: p.table,
            partition: p.partition,
            partitionId: p.partitionId,
            name: p.name,
            sizeBytes: p.sizeBytes,
          });
          currentUsage -= p.sizeBytes;
        } else {
          logger.info(
            `clickhouseRetention: Dropping detached part ${p.name} (${p.partition}) from ${p.table} (${(p.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          try {
            await dropDetachedPart(p.database, p.table, p.name);
            detachedDropped.push({
              database: p.database,
              table: p.table,
              partition: p.partition,
              partitionId: p.partitionId,
              name: p.name,
              sizeBytes: p.sizeBytes,
            });
            currentUsage -= p.sizeBytes;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error(
              { error, detachedPart: p },
              'clickhouseRetention: Failed to drop detached part, continuing',
            );
            detachedFailed.push({
              database: p.database,
              table: p.table,
              partition: p.partition,
              partitionId: p.partitionId,
              name: p.name,
              error: message,
            });
          }
        }
      }
    }

    if (nuke || (!dryRun && totalBefore > maxBytes)) {
      // Flush once, then truncate trace_log last. Flushing before every table
      // repopulates trace_log after it has already been truncated.
      await queryClickhouse('SYSTEM FLUSH LOGS');
      const systemLogTables = (await getSystemLogTablesBySize()).sort(
        (a, b) =>
          Number(a.table === 'trace_log') - Number(b.table === 'trace_log'),
      );

      for (const tableInfo of systemLogTables) {
        if (
          !nuke &&
          currentUsage <= maxBytes &&
          tableInfo.table !== 'trace_log'
        ) {
          continue;
        }

        if (dryRun) {
          logger.info(
            `[DRY RUN] Would truncate system log table ${tableInfo.table} (${(tableInfo.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          systemLogsTruncated.push(tableInfo);
          currentUsage -= tableInfo.sizeBytes;
        } else {
          logger.info(
            `clickhouseRetention: Truncating system log table ${tableInfo.table} (${(tableInfo.sizeBytes / (1024 * 1024)).toFixed(1)} MB)`,
          );
          try {
            await truncateSystemLogTable(tableInfo.table);
            systemLogsTruncated.push(tableInfo);
            currentUsage -= tableInfo.sizeBytes;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error(
              { error, table: tableInfo.table },
              'clickhouseRetention: Failed to truncate system log table, continuing',
            );
            systemLogsFailed.push({
              table: tableInfo.table,
              error: message,
            });
          }
        }
      }
    }

    const totalAfterGB = formatGB(currentUsage);
    const freeAfterGB = formatGB(Math.max(0, diskSizeBytes - currentUsage));
    const freedGB = formatGB(totalBefore - currentUsage);

    logger.info(
      `clickhouseRetention: ${dryRun ? '[DRY RUN] Would drop' : 'Dropped'} ${dropped.length} partition(s), ${detachedDropped.length} detached part(s), and ${systemLogsTruncated.length} system log table(s), freed ${freedGB} GB. Usage: ${totalBeforeGB} GB → ${totalAfterGB} GB`,
    );

    await writeAuditLog(
      dryRun
        ? 'clickhouse_retention.cleanup_dry_run'
        : 'clickhouse_retention.cleanup',
      {
        diskUsageBeforeGB: totalBeforeGB,
        diskUsageAfterGB: totalAfterGB,
        diskSizeGB,
        freeDiskBeforeGB: freeBeforeGB,
        freeDiskAfterGB: freeAfterGB,
        freedGB,
        targetUsagePercent: settings.targetUsagePercent,
        nuke,
        force,
        partitionsDropped: dropped.length,
        partitionsFailed: failed.length,
        detachedPartsDropped: detachedDropped.length,
        detachedPartsFailed: detachedFailed.length,
        systemLogTablesTruncated: systemLogsTruncated.length,
        systemLogTablesFailed: systemLogsFailed.length,
        dropped: dropped.map(d => ({
          database: d.database,
          table: d.table,
          partition: d.partition,
          partitionId: d.partitionId,
          oldestDateTime: d.oldestDateTime,
          sizeMB: (d.sizeBytes / (1024 * 1024)).toFixed(1),
        })),
        detachedDropped: detachedDropped.map(d => ({
          database: d.database,
          table: d.table,
          partition: d.partition,
          partitionId: d.partitionId,
          name: d.name,
          sizeMB: (d.sizeBytes / (1024 * 1024)).toFixed(1),
        })),
        systemLogsTruncated: systemLogsTruncated.map(d => ({
          table: d.table,
          sizeMB: (d.sizeBytes / (1024 * 1024)).toFixed(1),
        })),
        failed,
        detachedFailed,
        systemLogsFailed,
        dryRun,
      },
    );

    if (nuke && !dryRun) {
      const truncatedSystemTables = new Set(
        systemLogsTruncated.map(({ table }) => table),
      );
      const unrecoveredPartitionFailures = failed.filter(
        ({ database, table }) =>
          database !== 'system' || !truncatedSystemTables.has(table),
      );
      const failureCount =
        unrecoveredPartitionFailures.length +
        detachedFailed.length +
        systemLogsFailed.length;

      if (failureCount > 0) {
        throw new Error(
          `ClickHouse nuke incomplete: ${failureCount} cleanup operation(s) failed`,
        );
      }
    }
  }

  name(): string {
    return this.args.taskName;
  }

  async asyncDispose(): Promise<void> {}
}
