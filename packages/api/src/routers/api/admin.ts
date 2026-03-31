import express from 'express';
import {
  isUserAuthenticated,
  requireSuperAdmin,
} from '../../middleware/auth';
import AuditLog from '../../models/auditLog';
import User from '../../models/user';
import Team from '../../models/team';

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

// GET /admin/audit-log — global audit log (all teams)
router.get('/audit-log', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const [data, totalCount] = await Promise.all([
      AuditLog.find()
        .sort({ createdAt: -1 })
        .skip(page * limit)
        .limit(limit),
      AuditLog.countDocuments(),
    ]);

    res.json({ data, totalCount });
  } catch (e) {
    next(e);
  }
});

export default router;
