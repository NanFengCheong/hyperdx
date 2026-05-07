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

function makeSystemDisksResponse(usedBytes: number, freeBytes: number) {
  return makeSystemPartsResponse([
    { used: String(usedBytes), free: String(freeBytes) },
  ]);
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
      value: { maxDiskGB: 100, enabled: false },
    } as any);

    const task = new ClickhouseRetentionTask({
      taskName: TaskName.CLICKHOUSE_RETENTION,
      dryRun: false,
    });
    await task.execute();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should not drop partitions when under 80 percent threshold', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 100, enabled: true },
    } as any);

    // 50GB total - under 80GB threshold for a 100GB disk
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

  it('should drop oldest partitions when over 80 percent threshold (dry run)', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    // 15GB total - over 8GB threshold for a 10GB disk
    mockFetch.mockResolvedValueOnce(makeSystemDisksResponse(15 * GB, 0));

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
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(15 * GB, 0))
      .mockResolvedValueOnce(
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
            database: 'otel_json',
            table: 'otel_logs',
            partition: '2026-04-02',
            partitionId: '20260402',
            oldestDateTime: '2026-04-02 00:00:00',
            sizeBytes: String(5 * GB),
          },
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-03',
            partitionId: '20260403',
            oldestDateTime: '2026-04-03 00:00:00',
            sizeBytes: String(4.5 * GB),
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
          diskUsageAfterGB: '4.50',
          freeDiskAfterGB: '5.50',
          partitionsDropped: 3,
          targetUsagePercent: 80,
        }),
      }),
    );
  });

  it('should continue cleanup when one partition drop fails', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(15 * GB, 0))
      .mockResolvedValueOnce(
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
            partition: '2026-04-02',
            partitionId: '20260402',
            oldestDateTime: '2026-04-02 00:00:00',
            sizeBytes: String(5 * GB),
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
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(13.9 * GB, 0))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'custom_large_telemetry',
            partition: '2026-04-01',
            partitionId: '20260401',
            oldestDateTime: '2026-04-01 00:00:00',
            sizeBytes: String(6 * GB),
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
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(20 * GB, 0))
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
      .mockResolvedValueOnce(makeSystemPartsResponse([]))
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            database: 'default',
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            name: '20260401_1_1_0',
            sizeBytes: String(8 * GB),
          },
          {
            database: 'default',
            table: 'otel_traces',
            partition: '2026-04-02',
            partitionId: '20260402',
            name: '20260402_1_1_0',
            sizeBytes: String(4 * GB),
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
      value: { maxDiskGB: 20, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(19.5 * GB, 0))
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

  it('should use default settings when no PlatformSetting exists', async () => {
    mockPlatformSettingFindOne.mockResolvedValue(null);

    // Under default 100GB
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
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    mockFetch
      .mockResolvedValueOnce(makeSystemDisksResponse(9 * GB, 0))
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
});
