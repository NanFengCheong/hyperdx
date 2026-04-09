import mongoose from 'mongoose';

import { clearDBCollections, closeDB, connectDB } from '@/fixtures';
import AlertHistory, { IAlertHistory } from '@/models/alertHistory';
import AuditLog from '@/models/auditLog';
import DataRetentionTask, { applyRetention } from '@/tasks/dataRetention';
import { TaskName } from '@/tasks/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const fakeObjectId = new mongoose.Types.ObjectId();

describe('DataRetentionTask', () => {
  beforeAll(async () => {
    await connectDB();
  });

  afterEach(async () => {
    await clearDBCollections();
  });

  afterAll(async () => {
    await closeDB();
  });

  describe('applyRetention', () => {
    it('deletes AuditLog entries older than retention period', async () => {
      // Create old audit log (95 days ago, default retention is 90 days)
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'old@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-123',
        createdAt: new Date(Date.now() - 95 * DAY_MS),
      });

      // Create recent audit log (10 days ago)
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'recent@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-456',
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      });

      const deletedCount = await applyRetention('AuditLog', 90, false);

      expect(deletedCount).toBe(1);
      const remainingLogs = await AuditLog.find();
      expect(remainingLogs).toHaveLength(1);
      expect(remainingLogs[0].actorEmail).toBe('recent@example.com');
    });

    it('does not delete anything in dry run mode', async () => {
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'old@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-123',
        createdAt: new Date(Date.now() - 95 * DAY_MS),
      });

      const deletedCount = await applyRetention('AuditLog', 90, true);

      expect(deletedCount).toBe(1); // Reports what would be deleted
      const remainingLogs = await AuditLog.find();
      expect(remainingLogs).toHaveLength(1); // But nothing was actually deleted
    });

    it('returns 0 when no documents are older than retention period', async () => {
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'recent@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-456',
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      });

      const deletedCount = await applyRetention('AuditLog', 90, false);

      expect(deletedCount).toBe(0);
    });

    it('handles retention boundary correctly', async () => {
      // 89 days ago — should NOT be deleted
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'boundary-safe@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-1',
        createdAt: new Date(Date.now() - 89 * DAY_MS),
      });

      // 91 days ago — should be deleted
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'expired@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-2',
        createdAt: new Date(Date.now() - 91 * DAY_MS),
      });

      const deletedCount = await applyRetention('AuditLog', 90, false);

      expect(deletedCount).toBe(1);
      const remaining = await AuditLog.find();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].actorEmail).toBe('boundary-safe@example.com');
    });

    it('returns 0 for unknown collection', async () => {
      const deletedCount = await applyRetention('UnknownCollection', 90, false);
      expect(deletedCount).toBe(0);
    });
  });

  describe('DataRetentionTask class', () => {
    it('executes without error in dry run mode', async () => {
      // Create some old data
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'old@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-123',
        createdAt: new Date(Date.now() - 95 * DAY_MS),
      });

      const task = new DataRetentionTask({
        taskName: TaskName.DATA_RETENTION,
        dryRun: true,
      });

      await expect(task.execute()).resolves.not.toThrow();
      expect(task.name()).toBe(TaskName.DATA_RETENTION);

      // Verify data still exists (dry run)
      const logs = await AuditLog.find();
      expect(logs).toHaveLength(1);

      await task.asyncDispose();
    });

    it('executes and deletes data when not in dry run mode', async () => {
      // Create old and new data
      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'old@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-123',
        createdAt: new Date(Date.now() - 95 * DAY_MS),
      });

      await AuditLog.create({
        teamId: fakeObjectId,
        actorId: fakeObjectId,
        actorEmail: 'recent@example.com',
        action: 'user.login',
        targetType: 'User',
        targetId: 'user-456',
        createdAt: new Date(Date.now() - 10 * DAY_MS),
      });

      const task = new DataRetentionTask({
        taskName: TaskName.DATA_RETENTION,
        dryRun: false,
      });

      await expect(task.execute()).resolves.not.toThrow();

      // Verify only old data was deleted
      const logs = await AuditLog.find();
      expect(logs).toHaveLength(1);
      expect(logs[0].actorEmail).toBe('recent@example.com');

      await task.asyncDispose();
    });

    it('handles empty collections gracefully', async () => {
      const task = new DataRetentionTask({
        taskName: TaskName.DATA_RETENTION,
        dryRun: false,
      });

      await expect(task.execute()).resolves.not.toThrow();
      await task.asyncDispose();
    });
  });
});
