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

import AuditLog from '@/models/auditLog';
import PlatformSetting from '@/models/platformSetting';
import ClickhouseRetentionTask, {
  getClickHouseRetentionStatus,
} from '@/tasks/clickhouseRetention';
import { TaskName } from '@/tasks/types';

const mockPlatformSettingFindOne = jest.mocked(PlatformSetting.findOne);
const mockAuditLogCreate = jest.mocked(AuditLog.create);

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeSystemPartsResponse(data: any[]) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function makeSystemDisksResponse(usedBytes: number, freeBytes: number) {
  return makeSystemPartsResponse([
    {
      total: String(usedBytes + freeBytes),
      used: String(usedBytes),
      free: String(freeBytes),
    },
  ]);
}

function formatGB(bytes: number) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(2);
}

function getFetchQueries() {
  return mockFetch.mock.calls.map(call => (call[1] as RequestInit).body);
}

describe('ClickhouseRetentionTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should skip when disabled', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: false },
    } as any);

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not drop partitions when under 90 percent threshold', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true },
    } as any);

    // Used space is under the detected filesystem threshold.
    mockFetch.mockResolvedValueOnce(
      makeSystemDisksResponse(50 * 1024 * 1024 * 1024, 50 * 1024 * 1024 * 1024),
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

  it('should nuke ClickHouse cleanup candidates even when under threshold', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(5 * GB, 5 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(1 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            table: 'trace_log',
            sizeBytes: String(2 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(makeSystemPartsResponse([]));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
      nuke: true,
      force: true,
    });
    await task.execute();

    const queries = getFetchQueries();

    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_logs` DROP PARTITION ID '20260401'",
    );
    expect(queries).toContain('TRUNCATE TABLE `system`.`trace_log`');
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup',
        details: expect.objectContaining({
          nuke: true,
          force: true,
          partitionsDropped: 1,
          systemLogTablesTruncated: 1,
        }),
      }),
    );
  });

  it('should not nuke below threshold unless forced', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;
    mockFetch.mockResolvedValueOnce(makeSystemDisksResponse(5 * GB, 5 * GB));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
      nuke: true,
    });
    await task.execute();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.check',
        details: expect.objectContaining({
          nuke: true,
          force: false,
        }),
      }),
    );
  });

  it('should use configured cleanup threshold instead of hardcoded default', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 95 },
    } as any);

    // 92GB total - over default 90GB threshold, under configured 95GB threshold
    mockFetch.mockResolvedValueOnce(
      makeSystemDisksResponse(92 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    );

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.check',
        details: expect.objectContaining({
          targetUsagePercent: 95,
        }),
      }),
    );
  });

  it('should drop oldest partitions when over 80 percent threshold (dry run)', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    // 9GB used on a 10GB disk - over 8GB threshold
    mockFetch.mockResolvedValueOnce(makeSystemDisksResponse(9 * GB, 1 * GB));

    // Partition listing - 3 dates, ~5GB each
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([
        {
          database: 'default',
          table: 'otel_logs',
          partition: '2026-04-01',
          partitionId: '20260401',
          oldestDateTime: '2026-04-01 00:00:00',
          sizeBytes: String(5 * GB),
        },
        {
          database: 'default',
          table: 'otel_traces',
          partition: '2026-04-01',
          partitionId: '20260401',
          oldestDateTime: '2026-04-01 00:00:00',
          sizeBytes: String(0.5 * GB),
        },
        {
          database: 'default',
          table: 'otel_logs',
          partition: '2026-04-02',
          partitionId: '20260402',
          oldestDateTime: '2026-04-02 00:00:00',
          sizeBytes: String(5 * GB),
        },
        {
          database: 'default',
          table: 'otel_traces',
          partition: '2026-04-02',
          partitionId: '20260402',
          oldestDateTime: '2026-04-02 00:00:00',
          sizeBytes: String(0.5 * GB),
        },
        {
          database: 'default',
          table: 'otel_logs',
          partition: '2026-04-03',
          partitionId: '20260403',
          oldestDateTime: '2026-04-03 00:00:00',
          sizeBytes: String(4 * GB),
        },
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
        details: expect.objectContaining({
          targetUsagePercent: 80,
        }),
      }),
    );
  });

  it('should drop partition IDs oldest first until usage is below 80 percent', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(9 * GB, 1 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(0.6 * GB),
          },
          {
            database: 'default',
            table: 'otel_traces',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(0.2 * GB),
          },
          {
            database: 'otel_json',
            table: 'otel_logs',
            partition: '2026-04-02',
            partitionId: '20260402',
            oldestDateTime: '2026-04-02 00:00:00',
            sizeBytes: String(0.6 * GB),
          },
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-03',
            partitionId: '20260403',
            oldestDateTime: '2026-04-03 00:00:00',
            sizeBytes: String(0.5 * GB),
          },
        ]),
      )
      .mockImplementation(() => Promise.resolve(makeSystemPartsResponse([])));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    const queries = getFetchQueries();

    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_logs` DROP PARTITION ID '20260401'",
    );
    expect(queries[1]).toContain('toString(min(min_time))');
    expect(queries[1]).toContain('ORDER BY oldestDateTime ASC');
    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_traces` DROP PARTITION ID '20260401'",
    );
    expect(queries).toContain(
      "ALTER TABLE `otel_json`.`otel_logs` DROP PARTITION ID '20260402'",
    );
    expect(queries).not.toContain(
      "ALTER TABLE `default`.`otel_logs` DROP PARTITION ID '20260403'",
    );
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup',
        details: expect.objectContaining({
          diskUsageAfterGB: '7.60',
          freeDiskAfterGB: '2.40',
          partitionsDropped: 3,
          targetUsagePercent: 80,
        }),
      }),
    );
  });

  it('should continue cleanup when one partition drop fails', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(9 * GB, 1 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(1.5 * GB),
          },
          {
            database: 'default',
            table: 'otel_traces',
            partition: '2026-04-02',
            partitionId: '20260402',
            oldestDateTime: '2026-04-02 00:00:00',
            sizeBytes: String(1.5 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(new Response('drop failed', { status: 500 }))
      .mockResolvedValueOnce(makeSystemPartsResponse([]));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await expect(task.execute()).resolves.toBeUndefined();

    const queries = getFetchQueries();

    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_logs` DROP PARTITION ID '20260401'",
    );
    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_traces` DROP PARTITION ID '20260402'",
    );
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup',
        details: expect.objectContaining({
          partitionsDropped: 1,
          partitionsFailed: 1,
        }),
      }),
    );
  });

  it('should include non-otel user tables in disk usage and cleanup candidates', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(9 * GB, 1 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'custom_large_telemetry',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(2 * GB),
          },
        ]),
      )
      .mockImplementation(() => Promise.resolve(makeSystemPartsResponse([])));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    const queries = getFetchQueries();

    expect(queries[1]).toContain(
      "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')",
    );
    expect(queries[1]).toContain("database = 'system' AND table IN");
    expect(queries).toContain(
      "ALTER TABLE `default`.`custom_large_telemetry` DROP PARTITION ID '20260401'",
    );
  });

  it('should drop detached parts when active partitions do not reclaim enough space', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(9.5 * GB, 0.5 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(0.5 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            name: '20260401_1_1_0',
            sizeBytes: String(0.75 * GB),
          },
          {
            database: 'default',
            table: 'otel_traces',
            partition: '2026-04-02',
            partitionId: '20260402',
            name: '20260402_1_1_0',
            sizeBytes: String(0.5 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(makeSystemPartsResponse([]));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    const queries = getFetchQueries();

    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_logs` DROP PARTITION ID '20260401'",
    );
    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_logs` DROP DETACHED PART '20260401_1_1_0'",
    );
    expect(queries).toContain(
      "ALTER TABLE `default`.`otel_traces` DROP DETACHED PART '20260402_1_1_0'",
    );
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup',
        details: expect.objectContaining({
          partitionsDropped: 1,
          detachedPartsDropped: 2,
        }),
      }),
    );
  });

  it('should clean ClickHouse system trace log partitions', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(19.5 * GB, 0.5 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'system',
            table: 'trace_log',
            partition: '2026-04-14',
            partitionId: '20260414',
            oldestDateTime: '2026-04-14 00:00:00',
            sizeBytes: String(4 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    const queries = getFetchQueries();

    expect(queries[1]).toContain("database = 'system' AND table IN");
    expect(queries).toContain(
      "ALTER TABLE `system`.`trace_log` DROP PARTITION ID '20260414'",
    );
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup',
        details: expect.objectContaining({
          partitionsDropped: 1,
        }),
      }),
    );
  });

  it('should truncate large system log tables when partition cleanup cannot reach threshold', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(19.5 * GB, 0.5 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'system',
            table: 'trace_log',
            partition: '202604',
            partitionId: '202604',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(2 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(new Response('drop failed', { status: 500 }))
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            table: 'trace_log',
            sizeBytes: String(13.5 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(makeSystemPartsResponse([]));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    const queries = getFetchQueries();

    expect(queries).toContain(
      "ALTER TABLE `system`.`trace_log` DROP PARTITION ID '202604'",
    );
    expect(queries).toContain('SYSTEM FLUSH LOGS');
    expect(queries).toContain('TRUNCATE TABLE `system`.`trace_log`');
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clickhouse_retention.cleanup',
        details: expect.objectContaining({
          partitionsFailed: 1,
          systemLogTablesTruncated: 1,
          systemLogTablesFailed: 0,
        }),
      }),
    );
  });

  it('should use default settings when no PlatformSetting exists', async () => {
    mockPlatformSettingFindOne.mockResolvedValue(null);

    // Used space is under the detected filesystem threshold.
    mockFetch.mockResolvedValueOnce(
      makeSystemDisksResponse(50 * 1024 * 1024 * 1024, 50 * 1024 * 1024 * 1024),
    );

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should send ClickHouse queries with POST so ALTER is not readonly', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { enabled: true, targetUsagePercent: 80 },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(9 * GB, 1 * GB))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(2 * GB),
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemPartsResponse([]));

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8123/',
      expect.objectContaining({
        method: 'POST',
        body: "ALTER TABLE `default`.`otel_logs` DROP PARTITION ID '20260401'",
      }),
    );
  });

  it('should report detected filesystem size instead of a hardcoded disk cap', async () => {
    mockFetch.mockReset();
    const GB = 1024 * 1024 * 1024;
    const usedBytes = 19.52 * GB;
    const freeBytes = 0.48 * GB;
    const detectedBytes = usedBytes + freeBytes;
    const targetUsagePercent = 80;

    mockFetch
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_metrics_gauge',
            bytes: String(18.73 * GB),
            oldest_partition: '2026-06-17',
            newest_partition: '2026-06-26',
            partition_count: '4',
          },
        ]),
      )
      .mockResolvedValueOnce(makeSystemDisksResponse(usedBytes, freeBytes))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          { active: '1', bytes: String(19.33 * GB) },
          { active: '0', bytes: String(0.01 * GB) },
        ]),
      )
      .mockResolvedValueOnce(
        makeSystemPartsResponse([{ bytes: String(0.0 * GB) }]),
      );

    const status = await getClickHouseRetentionStatus(true, targetUsagePercent);

    expect(status).toEqual(
      expect.objectContaining({
        diskSizeGB: formatGB(detectedBytes),
        totalSizeGB: formatGB(usedBytes),
        freeDiskGB: formatGB(freeBytes),
        usagePercent: '97.6',
        thresholdGB: formatGB(detectedBytes * (targetUsagePercent / 100)),
        isOverThreshold: true,
      }),
    );
  });
});
