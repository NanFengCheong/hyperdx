import express from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { validateRequest } from 'zod-express-middleware';

import {
  RETENTION_DAYS_ALERTHISTORY,
  RETENTION_DAYS_AUDITLOG,
} from '../../config';
import * as config from '../../config';
import { isUserAuthenticated, requireSuperAdmin } from '../../middleware/auth';
import AuditLog from '../../models/auditLog';
import NotificationLog from '../../models/notificationLog';
import PlatformSetting from '../../models/platformSetting';
import Team from '../../models/team';
import User from '../../models/user';
import ClickhouseRetentionTask from '../../tasks/clickhouseRetention';
import DataRetentionTask from '../../tasks/dataRetention';
import { getTransporter } from '../../utils/emailService';
import {
  createNotificationEntry,
  markNotificationFailed,
  markNotificationSuccess,
} from '../../utils/notificationLogger';

const router = express.Router();

// All admin routes require super admin
router.use(isUserAuthenticated);
router.use(requireSuperAdmin);

// GET /admin/teams — list all teams
router.get('/teams', async (req, res, next) => {
  try {
    const teams = await Team.find().sort({ createdAt: -1 });
    res.json({ data: teams });
  } catch (e) {
    next(e);
  }
});

// GET /admin/team/:id/members — list members of a specific team
router.get('/team/:id/members', async (req, res, next) => {
  try {
    const members = await User.find({ team: req.params.id })
      .select('email name roleId isSuperAdmin permissionOverrides')
      .populate('roleId');
    res.json({ data: members });
  } catch (e) {
    next(e);
  }
});

// PATCH /admin/user/:id/super-admin — toggle super admin status
router.patch('/user/:id/super-admin', async (req, res, next) => {
  try {
    const { isSuperAdmin } = req.body;
    const actor = req.user as any;

    const targetUser = await User.findById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent removing own super admin
    if (targetUser._id.equals(actor._id) && !isSuperAdmin) {
      return res
        .status(400)
        .json({ message: 'Cannot remove your own super admin status' });
    }

    (targetUser as any).isSuperAdmin = isSuperAdmin;
    await targetUser.save();

    await AuditLog.create({
      teamId: (targetUser as any).team,
      actorId: actor._id,
      actorEmail: actor.email,
      action: isSuperAdmin ? 'superadmin:granted' : 'superadmin:revoked',
      targetType: 'user',
      targetId: targetUser._id,
      details: { email: (targetUser as any).email },
    });

    res.json({ data: { ok: true } });
  } catch (e) {
    next(e);
  }
});

// GET /admin/audit-log — global audit log (all teams) with optional filters
router.get('/audit-log', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    // Build filter query
    const filter: Record<string, any> = {};

    // Date range filter
    if (req.query.fromDate) {
      filter.createdAt = {
        ...filter.createdAt,
        $gte: new Date(req.query.fromDate as string),
      };
    }
    if (req.query.toDate) {
      filter.createdAt = {
        ...filter.createdAt,
        $lte: new Date(req.query.toDate as string),
      };
    }

    // Actor email filter
    if (req.query.actorEmail) {
      filter.actorEmail = {
        $regex: req.query.actorEmail as string,
        $options: 'i',
      };
    }

    const [data, totalCount] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    res.json({ data, totalCount, page, limit });
  } catch (e) {
    next(e);
  }
});

// GET /admin/notification-log — global notification log (all teams) with optional filters
router.get('/notification-log', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const filter: Record<string, any> = {};

    if (req.query.teamId) {
      filter.teamId = req.query.teamId;
    }
    if (req.query.channel) {
      filter.channel = req.query.channel;
    }
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.recipient) {
      filter.recipient = { $regex: req.query.recipient, $options: 'i' };
    }
    if (req.query.triggerType) {
      filter['trigger.type'] = req.query.triggerType;
    }
    if (req.query.fromDate || req.query.toDate) {
      filter.createdAt = {};
      if (req.query.fromDate) {
        filter.createdAt.$gte = new Date(req.query.fromDate as string);
      }
      if (req.query.toDate) {
        filter.createdAt.$lte = new Date(req.query.toDate as string);
      }
    }
    if (req.query.search) {
      const search = req.query.search as string;
      filter.$or = [
        { recipient: { $regex: search, $options: 'i' } },
        { subject: { $regex: search, $options: 'i' } },
      ];
    }

    const [data, totalCount] = await Promise.all([
      NotificationLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit),
      NotificationLog.countDocuments(filter),
    ]);

    res.json({ data, totalCount, page, limit });
  } catch (e) {
    next(e);
  }
});

// GET /admin/notification-log/retention
router.get('/notification-log/retention', async (req, res, next) => {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'notificationLogRetentionDays',
    });
    res.json({ retentionDays: (setting?.value as unknown as number) ?? 30 });
  } catch (e) {
    next(e);
  }
});

// PUT /admin/notification-log/retention
router.put('/notification-log/retention', async (req, res, next) => {
  try {
    const { retentionDays } = req.body;
    if (typeof retentionDays !== 'number' || retentionDays < 1) {
      return res
        .status(400)
        .json({ message: 'retentionDays must be a positive number' });
    }
    const actor = req.user as any;
    await PlatformSetting.findOneAndUpdate(
      { key: 'notificationLogRetentionDays' },
      { key: 'notificationLogRetentionDays', value: retentionDays },
      { upsert: true },
    );
    await AuditLog.create({
      teamId: actor._id,
      actorId: actor._id,
      actorEmail: actor.email,
      action: 'notification_log.retention_updated',
      targetType: 'PlatformSetting',
      targetId: 'notificationLogRetentionDays',
      details: { retentionDays },
    });
    res.json({ retentionDays });
  } catch (e) {
    next(e);
  }
});

// POST /admin/notification-log/:id/retry
router.post('/notification-log/:id/retry', async (req, res, next) => {
  try {
    const original = await NotificationLog.findOne({
      _id: req.params.id,
      status: 'failed',
    });

    if (!original) {
      return res
        .status(404)
        .json({ message: 'Notification not found or not failed' });
    }

    if (original.channel === 'email') {
      const logEntry = await createNotificationEntry({
        teamId: original.teamId,
        channel: 'email',
        recipient: original.recipient,
        trigger: original.trigger,
        subject: original.subject,
        payload: original.payload as Record<string, unknown>,
        retryOf: original._id,
      });

      try {
        const transport = getTransporter();
        if (!transport) {
          await markNotificationFailed(logEntry._id, 'SMTP not configured');
          const updated = await NotificationLog.findById(logEntry._id);
          return res.json({ data: updated });
        }
        const info = await transport.sendMail({
          from: `"${config.SMTP_FROM_NAME}" <${config.SMTP_FROM}>`,
          to: original.recipient,
          subject: original.subject,
          html: (original.payload as any)?.html ?? '',
          text: (original.payload as any)?.text ?? '',
        });
        await markNotificationSuccess(logEntry._id, {
          messageId: info.messageId,
          response: info.response,
        });
        const updated = await NotificationLog.findById(logEntry._id);
        return res.json({ data: updated });
      } catch (error) {
        await markNotificationFailed(
          logEntry._id,
          error instanceof Error ? error.message : String(error),
        );
        const updated = await NotificationLog.findById(logEntry._id);
        return res.json({ data: updated });
      }
    }

    if (original.channel === 'webhook') {
      const logEntry = await createNotificationEntry({
        teamId: original.teamId,
        channel: 'webhook',
        recipient: original.recipient,
        trigger: original.trigger,
        subject: original.subject,
        payload: original.payload as Record<string, unknown>,
        retryOf: original._id,
      });

      try {
        const resp = await fetch(original.recipient, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify((original.payload as any)?.body ?? {}),
        });
        if (resp.ok) {
          await markNotificationSuccess(logEntry._id, {
            status: resp.status,
            statusText: resp.statusText,
          });
        } else {
          const body = await resp.text().catch(() => '');
          await markNotificationFailed(logEntry._id, `HTTP ${resp.status}`, {
            status: resp.status,
            body: body.slice(0, 1000),
          });
        }
        const updated = await NotificationLog.findById(logEntry._id);
        return res.json({ data: updated });
      } catch (error) {
        await markNotificationFailed(
          logEntry._id,
          error instanceof Error ? error.message : String(error),
        );
        const updated = await NotificationLog.findById(logEntry._id);
        return res.json({ data: updated });
      }
    }

    return res
      .status(400)
      .json({ message: `Unsupported channel: ${original.channel}` });
  } catch (e) {
    next(e);
  }
});

// GET /admin/data-retention/settings — get current retention settings
router.get('/data-retention/settings', async (req, res, next) => {
  try {
    const setting = await PlatformSetting.findOne({ key: 'dataRetention' });

    const defaults = {
      auditLog: RETENTION_DAYS_AUDITLOG,
      alertHistory: RETENTION_DAYS_ALERTHISTORY,
    };

    const value = setting?.value as Record<string, number> | undefined;

    res.json({
      data: {
        auditLog: value?.auditLog ?? defaults.auditLog,
        alertHistory: value?.alertHistory ?? defaults.alertHistory,
      },
    });
  } catch (e) {
    next(e);
  }
});

// PUT /admin/data-retention/settings — update retention settings
const retentionSettingsSchema = z.object({
  auditLog: z.number().int().min(1).max(3650),
  alertHistory: z.number().int().min(1).max(3650),
});

router.put('/data-retention/settings', async (req, res, next) => {
  try {
    const actor = req.user as any;
    const parseResult = retentionSettingsSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        message: 'Invalid settings',
        errors: parseResult.error.errors,
      });
    }

    const { auditLog, alertHistory } = parseResult.data;

    await PlatformSetting.findOneAndUpdate(
      { key: 'dataRetention' },
      {
        $set: {
          value: { auditLog, alertHistory },
          updatedBy: actor._id,
        },
      },
      { upsert: true, new: true },
    );

    await AuditLog.create({
      teamId: actor._id,
      actorId: actor._id,
      actorEmail: actor.email,
      action: 'data_retention.settings_updated',
      targetType: 'PlatformSetting',
      targetId: 'dataRetention',
      details: { auditLog, alertHistory },
    });

    res.json({ data: { ok: true } });
  } catch (e) {
    next(e);
  }
});

// POST /admin/data-retention/run — manual data retention cleanup
const dataRetentionRunSchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

router.post('/data-retention/run', async (req, res, next) => {
  try {
    const actor = req.user as any;

    const parseResult = dataRetentionRunSchema.safeParse(req.body ?? {});
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
        ? 'data_retention.manual_dry_run'
        : 'data_retention.manual_run',
      targetType: 'System',
      targetId: 'data-retention',
      details: { triggeredBy: actor.email, dryRun },
    });

    const task = new DataRetentionTask({
      taskName: 'data-retention' as any,
      dryRun,
    });

    try {
      await task.execute();
      res.json({ data: { ok: true, dryRun } });
    } finally {
      await task.asyncDispose();
    }
  } catch (e) {
    next(e);
  }
});

// GET /admin/clickhouse-retention/settings — read config
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

// PUT /admin/clickhouse-retention/settings — update config
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

// GET /admin/clickhouse-retention/status — current ClickHouse disk usage
router.get('/clickhouse-retention/status', async (req, res, next) => {
  try {
    const { CLICKHOUSE_HOST } = await import('../../config');
    const url = new URL(CLICKHOUSE_HOST);

    const tables = [
      'otel_logs',
      'otel_traces',
      'otel_metrics_gauge',
      'otel_metrics_sum',
      'otel_metrics_histogram',
      'otel_metrics_exponential_histogram',
      'otel_metrics_summary',
      'hyperdx_sessions',
    ];
    const tableList = tables.map(t => `'${t}'`).join(',');

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
        usagePercent: (
          (totalBytes / (maxDiskGB * 1024 * 1024 * 1024)) *
          100
        ).toFixed(1),
        tables: tableStats,
      },
    });
  } catch (e) {
    next(e);
  }
});

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
      res.json({ data: { ok: true, dryRun } });
    } finally {
      await task.asyncDispose();
    }
  } catch (e) {
    next(e);
  }
});

// Proactive investigation config schema
const proactiveInvestigationConfigSchema = z
  .object({
    enabled: z.boolean(),
    triageCron: z.string(),
    runnerCron: z.string(),
    modelName: z.string(),
    modelBaseUrl: z.string().optional(),
    maxRunsPerTeamHour: z.number().int().positive(),
    reopenAfterHours: z.number().int().positive(),
    memoryTTLDays: z.number().int().positive(),
    budget: z
      .object({
        maxToolCalls: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        maxWallclockMs: z.number().int().positive(),
      })
      .partial()
      .optional(),
    anomalySweep: z
      .object({
        errorRateMultiplier: z.number().positive(),
        minAbsoluteCount: z.number().int().nonnegative(),
        topK: z.number().int().positive(),
        lookbackMinutes: z.number().int().positive(),
        baselineHours: z.number().int().positive(),
      })
      .partial()
      .optional(),
    circuitBreaker: z
      .object({
        maxFailuresPerHour: z.number().int().positive(),
        pauseMinutes: z.number().int().positive(),
      })
      .partial()
      .optional(),
  })
  .partial();

// GET /admin/settings/proactive-investigation — read config
router.get('/settings/proactive-investigation', async (req, res, next) => {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'proactiveInvestigation',
    });
    res.json({ data: setting?.value ?? null });
  } catch (e) {
    next(e);
  }
});

// PATCH /admin/settings/proactive-investigation — update config
router.patch(
  '/settings/proactive-investigation',
  validateRequest({ body: proactiveInvestigationConfigSchema }),
  async (req, res, next) => {
    try {
      const actor = req.user as any;
      const userId = actor?._id;
      const setting = await PlatformSetting.findOneAndUpdate(
        { key: 'proactiveInvestigation' },
        { $set: { value: req.body, updatedBy: userId } },
        { upsert: true, new: true },
      );
      res.json({ data: setting });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
