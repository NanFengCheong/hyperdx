import express from 'express';
import { z } from 'zod';
import {
  isUserAuthenticated,
  requireSuperAdmin,
} from '../../middleware/auth';
import AuditLog from '../../models/auditLog';
import User from '../../models/user';
import Team from '../../models/team';
import DataRetentionTask from '../../tasks/dataRetention';
import PlatformSetting from '../../models/platformSetting';
import {
  RETENTION_DAYS_AUDITLOG,
  RETENTION_DAYS_ALERTHISTORY,
} from '../../config';

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
      return res.status(400).json({ message: 'Cannot remove your own super admin status' });
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
      filter.createdAt = { ...filter.createdAt, $gte: new Date(req.query.fromDate as string) };
    }
    if (req.query.toDate) {
      filter.createdAt = { ...filter.createdAt, $lte: new Date(req.query.toDate as string) };
    }

    // Actor email filter
    if (req.query.actorEmail) {
      filter.actorEmail = { $regex: req.query.actorEmail as string, $options: 'i' };
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
      action: dryRun ? 'data_retention.manual_dry_run' : 'data_retention.manual_run',
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

export default router;
