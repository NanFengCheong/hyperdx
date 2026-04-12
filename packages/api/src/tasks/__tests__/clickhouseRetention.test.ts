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
        {
          table: 'otel_logs',
          partition: '2026-04-01',
          sizeBytes: String(5 * GB),
        },
        {
          table: 'otel_traces',
          partition: '2026-04-01',
          sizeBytes: String(0.5 * GB),
        },
        {
          table: 'otel_logs',
          partition: '2026-04-02',
          sizeBytes: String(5 * GB),
        },
        {
          table: 'otel_traces',
          partition: '2026-04-02',
          sizeBytes: String(0.5 * GB),
        },
        {
          table: 'otel_logs',
          partition: '2026-04-03',
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
