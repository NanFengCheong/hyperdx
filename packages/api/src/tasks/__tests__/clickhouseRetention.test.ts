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

  it('should drop oldest partitions when over 80 percent threshold (dry run)', async () => {
    mockPlatformSettingFindOne.mockResolvedValue({
      value: { maxDiskGB: 10, enabled: true },
    } as any);

    const GB = 1024 * 1024 * 1024;

    // 15GB total - over 8GB threshold for a 10GB disk
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([{ total: String(15 * GB) }]),
    );

    // Partition listing - 3 dates, ~5GB each
    mockFetch.mockResolvedValueOnce(
      makeSystemPartsResponse([
        {
          table: 'otel_logs',
          partition: '2026-04-01',
          partitionId: '20260401',
          sizeBytes: String(5 * GB),
        },
        {
          table: 'otel_traces',
          partition: '2026-04-01',
          partitionId: '20260401',
          sizeBytes: String(0.5 * GB),
        },
        {
          table: 'otel_logs',
          partition: '2026-04-02',
          partitionId: '20260402',
          sizeBytes: String(5 * GB),
        },
        {
          table: 'otel_traces',
          partition: '2026-04-02',
          partitionId: '20260402',
          sizeBytes: String(0.5 * GB),
        },
        {
          table: 'otel_logs',
          partition: '2026-04-03',
          partitionId: '20260403',
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
      .mockResolvedValueOnce(
        makeSystemPartsResponse([{ total: String(15 * GB) }]),
      )
      .mockResolvedValueOnce(
        makeSystemPartsResponse([
          {
            table: 'otel_logs',
            partition: '2026-04-01',
            partitionId: '20260401',
            sizeBytes: String(5 * GB),
          },
          {
            table: 'otel_traces',
            partition: '2026-04-01',
            partitionId: '20260401',
            sizeBytes: String(0.5 * GB),
          },
          {
            table: 'otel_logs',
            partition: '2026-04-02',
            partitionId: '20260402',
            sizeBytes: String(5 * GB),
          },
          {
            table: 'otel_logs',
            partition: '2026-04-03',
            partitionId: '20260403',
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

    const queries = mockFetch.mock.calls.map(call =>
      new URL(call[0] as string).searchParams.get('query'),
    );

    expect(queries).toContain(
      "ALTER TABLE otel_logs DROP PARTITION ID '20260401'",
    );
    expect(queries).toContain(
      "ALTER TABLE otel_traces DROP PARTITION ID '20260401'",
    );
    expect(queries).toContain(
      "ALTER TABLE otel_logs DROP PARTITION ID '20260402'",
    );
    expect(queries).not.toContain(
      "ALTER TABLE otel_logs DROP PARTITION ID '20260403'",
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
