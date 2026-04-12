# ClickHouse Disk-Based Data Retention Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a hard disk cap for ClickHouse (default 100GB) that drops oldest day-partitions when exceeded, configurable via platform admin settings in MongoDB. Also change the default TTL from 30 days to 90 days.

**Architecture:** A new scheduled task queries ClickHouse `system.parts` for total disk usage, compares against the configured `maxDiskGB` from PlatformSetting, and drops oldest date partitions across all telemetry tables until usage is under the cap. Admin API endpoints allow viewing/updating settings and triggering manual cleanup.

**Tech Stack:** Express, Mongoose (PlatformSetting), ClickHouse `system.parts` queries, Zod validation, existing task scheduler (CronJob)

---

### Task 1: Change default TTL from 720h to 2160h (90 days)

**Files:**
- Modify: `packages/api/src/opamp/controllers/opampController.ts:203,220`

**Step 1: Update the TTL defaults**

Change both occurrences of `720h` to `2160h`:

```typescript
// Line 203 (clickhouse/rrweb exporter)
ttl: '${env:HYPERDX_OTEL_EXPORTER_TABLES_TTL:-2160h}',

// Line 220 (clickhouse exporter)
ttl: '${env:HYPERDX_OTEL_EXPORTER_TABLES_TTL:-2160h}',
```

**Step 2: Verify no other references to 720h**

Run: `grep -r "720h" packages/api/src/`
Expected: No matches

**Step 3: Commit**

```bash
git add packages/api/src/opamp/controllers/opampController.ts
git commit -m "feat(retention): change default ClickHouse TTL from 30d to 90d"
```

---

### Task 2: Add CLICKHOUSE_RETENTION task type to task infrastructure

**Files:**
- Modify: `packages/api/src/tasks/types.ts`

**Step 1: Add enum value and schema**

Add to TaskName enum:
```typescript
CLICKHOUSE_RETENTION = 'clickhouse-retention',
```

Add new schema after `dataRetentionTaskArgsSchema`:
```typescript
const clickhouseRetentionTaskArgsSchema = z.object({
  taskName: z.literal(TaskName.CLICKHOUSE_RETENTION),
  dryRun: z.boolean().optional().default(false),
});
```

Export the type:
```typescript
export type ClickhouseRetentionTaskArgs = z.infer<typeof clickhouseRetentionTaskArgsSchema>;
```

Add to the discriminated union array:
```typescript
const taskArgsSchema = z.discriminatedUnion('taskName', [
  // ... existing schemas ...
  clickhouseRetentionTaskArgsSchema,
]);
```

**Step 2: Verify types compile**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | head -20`
Expected: Errors about missing ClickhouseRetentionTask import (expected, task not created yet)

**Step 3: Commit**

```bash
git add packages/api/src/tasks/types.ts
git commit -m "feat(retention): add CLICKHOUSE_RETENTION task type"
```

---

### Task 3: Create ClickHouse retention task

**Files:**
- Create: `packages/api/src/tasks/clickhouseRetention.ts`

**Step 1: Write the task implementation**

```typescript
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
async function dropPartition(
  table: string,
  partition: string,
): Promise<void> {
  await queryClickhouse(
    `ALTER TABLE ${table} DROP PARTITION '${partition}'`,
  );
}

export interface RetentionResult {
  diskUsageBeforeGB: string;
  diskUsageAfterGB: string;
  freedGB: string;
  maxDiskGB: number;
  enabled: boolean;
  partitionsDropped: number;
  dropped: { table: string; partition: string; sizeMB: string }[];
  dryRun: boolean;
  skipped?: boolean;
  reason?: string;
}

export default class ClickhouseRetentionTask
  implements HdxTask<ClickhouseRetentionTaskArgs>
{
  private _result: RetentionResult | null = null;

  constructor(private args: ClickhouseRetentionTaskArgs) {}

  /** Access the result after execute() completes */
  get result(): RetentionResult | null {
    return this._result;
  }

  async execute(): Promise<void> {
    const { dryRun } = this.args;
    const settings = await getSettings();

    if (!settings.enabled) {
      logger.info('clickhouseRetention: Disabled via settings, skipping');
      this._result = {
        diskUsageBeforeGB: '0',
        diskUsageAfterGB: '0',
        freedGB: '0',
        maxDiskGB: settings.maxDiskGB,
        enabled: false,
        partitionsDropped: 0,
        dropped: [],
        dryRun,
        skipped: true,
        reason: 'disabled',
      };
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
      this._result = {
        diskUsageBeforeGB: totalBeforeGB,
        diskUsageAfterGB: totalBeforeGB,
        freedGB: '0',
        maxDiskGB: settings.maxDiskGB,
        enabled: true,
        partitionsDropped: 0,
        dropped: [],
        dryRun,
      };
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

    const droppedSummary = dropped.map(d => ({
      table: d.table,
      partition: d.partition,
      sizeMB: (d.sizeBytes / (1024 * 1024)).toFixed(1),
    }));

    this._result = {
      diskUsageBeforeGB: totalBeforeGB,
      diskUsageAfterGB: totalAfterGB,
      freedGB,
      maxDiskGB: settings.maxDiskGB,
      enabled: true,
      partitionsDropped: dropped.length,
      dropped: droppedSummary,
      dryRun,
    };

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
        dropped: droppedSummary,
        dryRun,
      },
    );
  }

  name(): string {
    return this.args.taskName;
  }

  async asyncDispose(): Promise<void> {}
}
```

**Step 2: Verify types compile**

Run: `cd packages/api && npx tsc --noEmit 2>&1 | head -5`
Expected: No errors (or only unrelated ones)

**Step 3: Commit**

```bash
git add packages/api/src/tasks/clickhouseRetention.ts
git commit -m "feat(retention): add ClickHouse disk-based retention task"
```

---

### Task 4: Register task in scheduler

**Files:**
- Modify: `packages/api/src/tasks/index.ts`

**Step 1: Add import and case**

Add import:
```typescript
import ClickhouseRetentionTask from '@/tasks/clickhouseRetention';
```

Add case in `createTask` switch:
```typescript
case TaskName.CLICKHOUSE_RETENTION:
  return new ClickhouseRetentionTask(argv);
```

Add cron schedule (run alongside DATA_RETENTION, daily at 3:30 AM MYT):
```typescript
} else if (argv.taskName === TaskName.CLICKHOUSE_RETENTION) {
  // ClickHouse retention: daily at 3:30 AM MYT (19:30 UTC)
  logger.info('ClickHouse retention cron: daily at 3:30 AM MYT (19:30 UTC)');
  CronJob.from({
    cronTime: '30 19 * * *', // 19:30 UTC = 3:30 AM MYT
    waitForCompletion: true,
    onTick: async () => instrumentedMain(argv),
    errorHandler: async err => {
      console.error(err);
    },
    start: true,
    timeZone: 'UTC',
  });
}
```

**Step 2: Commit**

```bash
git add packages/api/src/tasks/index.ts
git commit -m "feat(retention): register ClickHouse retention task in scheduler"
```

---

### Task 5: Add admin API endpoints for ClickHouse retention

**Files:**
- Modify: `packages/api/src/routers/api/admin.ts`

**Step 1: Add import**

```typescript
import ClickhouseRetentionTask from '../../tasks/clickhouseRetention';
```

**Step 2: Add settings GET endpoint**

After the existing data-retention routes, add:

```typescript
// GET /admin/clickhouse-retention/settings
router.get('/clickhouse-retention/settings', async (req, res, next) => {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'clickhouseRetention',
    });
    const value = setting?.value as
      | { maxDiskGB?: number; enabled?: boolean }
      | undefined;
    res.json({
      data: {
        maxDiskGB: value?.maxDiskGB ?? 100,
        enabled: value?.enabled ?? true,
      },
    });
  } catch (e) {
    next(e);
  }
});
```

**Step 3: Add settings PUT endpoint**

```typescript
// PUT /admin/clickhouse-retention/settings
const clickhouseRetentionSettingsSchema = z.object({
  maxDiskGB: z.number().min(1).max(100000),
  enabled: z.boolean(),
});

router.put('/clickhouse-retention/settings', async (req, res, next) => {
  try {
    const actor = req.user as any;
    const parseResult = clickhouseRetentionSettingsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        message: 'Invalid settings',
        errors: parseResult.error.errors,
      });
    }

    const { maxDiskGB, enabled } = parseResult.data;

    await PlatformSetting.findOneAndUpdate(
      { key: 'clickhouseRetention' },
      {
        $set: {
          value: { maxDiskGB, enabled },
          updatedBy: actor._id,
        },
      },
      { upsert: true, new: true },
    );

    await AuditLog.create({
      teamId: actor._id,
      actorId: actor._id,
      actorEmail: actor.email,
      action: 'clickhouse_retention.settings_updated',
      targetType: 'PlatformSetting',
      targetId: 'clickhouseRetention',
      details: { maxDiskGB, enabled },
    });

    res.json({ data: { ok: true } });
  } catch (e) {
    next(e);
  }
});
```

**Step 4: Add status endpoint**

```typescript
// GET /admin/clickhouse-retention/status — current ClickHouse disk usage
router.get('/clickhouse-retention/status', async (req, res, next) => {
  try {
    const { CLICKHOUSE_HOST } = await import('../../config');
    const url = new URL(CLICKHOUSE_HOST);

    // Query total disk usage for telemetry tables
    const tables = [
      'otel_logs', 'otel_traces', 'otel_metrics_gauge', 'otel_metrics_sum',
      'otel_metrics_histogram', 'otel_metrics_exponential_histogram',
      'otel_metrics_summary', 'hyperdx_sessions',
    ];
    const tableList = tables.map(t => `'${t}'`).join(',');

    // Total usage
    url.searchParams.set(
      'query',
      `SELECT table, sum(bytes_on_disk) as bytes, min(partition) as oldest_partition, max(partition) as newest_partition, count(DISTINCT partition) as partition_count FROM system.parts WHERE active = 1 AND table IN (${tableList}) GROUP BY table FORMAT JSON`,
    );
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      return res.status(502).json({ message: 'Failed to query ClickHouse' });
    }
    const parsed = JSON.parse(await resp.text());

    const tableStats = (parsed.data ?? []).map((row: any) => ({
      table: row.table,
      sizeGB: (Number(row.bytes) / (1024 * 1024 * 1024)).toFixed(2),
      oldestPartition: row.oldest_partition,
      newestPartition: row.newest_partition,
      partitionCount: Number(row.partition_count),
    }));

    const totalBytes = (parsed.data ?? []).reduce(
      (sum: number, row: any) => sum + Number(row.bytes),
      0,
    );

    // Get settings
    const setting = await PlatformSetting.findOne({
      key: 'clickhouseRetention',
    });
    const value = setting?.value as
      | { maxDiskGB?: number; enabled?: boolean }
      | undefined;
    const maxDiskGB = value?.maxDiskGB ?? 100;

    res.json({
      data: {
        totalSizeGB: (totalBytes / (1024 * 1024 * 1024)).toFixed(2),
        maxDiskGB,
        enabled: value?.enabled ?? true,
        usagePercent: ((totalBytes / (maxDiskGB * 1024 * 1024 * 1024)) * 100).toFixed(1),
        tables: tableStats,
      },
    });
  } catch (e) {
    next(e);
  }
});
```

**Step 5: Add manual run endpoint**

```typescript
// POST /admin/clickhouse-retention/run — manual ClickHouse retention cleanup
const clickhouseRetentionRunSchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

router.post('/clickhouse-retention/run', async (req, res, next) => {
  try {
    const actor = req.user as any;
    const parseResult = clickhouseRetentionRunSchema.safeParse(req.body ?? {});
    if (!parseResult.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parseResult.error.errors,
      });
    }

    const { dryRun } = parseResult.data;

    await AuditLog.create({
      teamId: actor._id,
      actorId: actor._id,
      actorEmail: actor.email,
      action: dryRun
        ? 'clickhouse_retention.manual_dry_run'
        : 'clickhouse_retention.manual_run',
      targetType: 'System',
      targetId: 'clickhouse-retention',
      details: { triggeredBy: actor.email, dryRun },
    });

    const task = new ClickhouseRetentionTask({
      taskName: 'clickhouse-retention' as any,
      dryRun,
    });

    try {
      await task.execute();
      res.json({ data: { ok: true, dryRun, ...task.result } });
    } finally {
      await task.asyncDispose();
    }
  } catch (e) {
    next(e);
  }
});
```

**Step 6: Commit**

```bash
git add packages/api/src/routers/api/admin.ts
git commit -m "feat(retention): add admin API endpoints for ClickHouse disk retention"
```

---

### Task 6: Write unit test for ClickHouse retention task

**Files:**
- Create: `packages/api/src/tasks/__tests__/clickhouseRetention.test.ts`

**Step 1: Write the test file**

```typescript
import mongoose from 'mongoose';

// Mock modules before importing the task
jest.mock('@/config', () => ({
  CLICKHOUSE_HOST: 'http://localhost:8123',
}));

jest.mock('@/models/platformSetting', () => ({
  findOne: jest.fn(),
}));

jest.mock('@/models/auditLog', () => ({
  create: jest.fn(),
}));

import PlatformSetting from '@/models/platformSetting';
import AuditLog from '@/models/auditLog';
import ClickhouseRetentionTask from '@/tasks/clickhouseRetention';
import { TaskName } from '@/tasks/types';

const mockPlatformSettingFindOne = jest.mocked(PlatformSetting.findOne);
const mockAuditLogCreate = jest.mocked(AuditLog.create);

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeSystemPartsResponse(data: any[]) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

describe('ClickhouseRetentionTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should skip when disabled', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 100, enabled: false },
    } as any);

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not drop partitions when under limit', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 100, enabled: true },
    } as any);

    // 50GB total - under 100GB limit
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([{ total: String(50 * 1024 * 1024 * 1024) }]),
    );

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    // Only the total-usage query should fire, no partition queries
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.check',
      }),
    );
  });

  it('should drop oldest partitions when over limit (dry run)', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    // 15GB total - over 10GB limit
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([{ total: String(15 * GB) }]),
    );

    // Partition listing - 3 dates, ~5GB each
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([
        { table: 'otel_logs', partition: '2026-04-01', sizeBytes: String(5 * GB) },
        { table: 'otel_traces', partition: '2026-04-01', sizeBytes: String(0.5 * GB) },
        { table: 'otel_logs', partition: '2026-04-02', sizeBytes: String(5 * GB) },
        { table: 'otel_traces', partition: '2026-04-02', sizeBytes: String(0.5 * GB) },
        { table: 'otel_logs', partition: '2026-04-03', sizeBytes: String(4 * GB) },
      ]),
    );

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: true,
    });
    await task.execute();

    // Should NOT issue DROP queries in dry run
    // 2 queries: total usage + partition listing
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup_dry_run',
      }),
    );
  });

  it('should use default settings when no PlatformSetting exists', async () => {
    mockPlatformSettingFindOne.mockResolvedValue(null);

    // Under default 100GB
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([{ total: String(50 * 1024 * 1024 * 1024) }]),
    );

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run tests**

Run: `cd packages/api && yarn ci:unit src/tasks/__tests__/clickhouseRetention.test.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add packages/api/src/tasks/__tests__/clickhouseRetention.test.ts
git commit -m "test(retention): add unit tests for ClickHouse disk retention task"
```

---

### Task 7: Lint and type check

**Step 1: Run lint fix**

Run: `yarn lint:fix`

**Step 2: Run type check**

Run: `cd packages/api && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes for ClickHouse retention feature"
```

---

## Summary of Changes

| File | Action | Purpose |
|------|--------|---------|
| `packages/api/src/opamp/controllers/opampController.ts` | Modify | TTL 720h → 2160h |
| `packages/api/src/tasks/types.ts` | Modify | Add CLICKHOUSE_RETENTION enum + schema |
| `packages/api/src/tasks/clickhouseRetention.ts` | Create | Core cleanup logic |
| `packages/api/src/tasks/index.ts` | Modify | Register task + cron schedule |
| `packages/api/src/routers/api/admin.ts` | Modify | Admin CRUD + status + manual run |
| `packages/api/src/tasks/__tests__/clickhouseRetention.test.ts` | Create | Unit tests |

## PlatformSetting Schema

Key: `clickhouseRetention`
```json
{
  "maxDiskGB": 100,
  "enabled": true
}
```

## API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/admin/clickhouse-retention/settings` | Read config |
| PUT | `/admin/clickhouse-retention/settings` | Update config |
| GET | `/admin/clickhouse-retention/status` | Current disk usage + per-table breakdown |
| POST | `/admin/clickhouse-retention/run` | Manual trigger (supports dryRun) |
