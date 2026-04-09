import {
  ALL_PERMISSIONS,
  resolvePermissions,
} from '@hyperdx/common-utils/dist/permissions';
import type {
  RotateApiKeyApiResponse,
  TeamApiResponse,
  TeamInvitationsApiResponse,
  TeamMembersApiResponse,
  TeamTagsApiResponse,
  UpdateClickHouseSettingsApiResponse,
} from '@hyperdx/common-utils/dist/types';
import {
  TeamClickHouseSettingsSchema,
  TelegramConfigSchema,
} from '@hyperdx/common-utils/dist/types';
import crypto from 'crypto';
import express from 'express';
import pick from 'lodash/pick';
import mongoose from 'mongoose';
import { z } from 'zod';
import { processRequest, validateRequest } from 'zod-express-middleware';

import * as config from '@/config';
import {
  getTags,
  getTeam,
  getTeamTelegramConfig,
  rotateTeamApiKey,
  setTeamName,
  updateTeamClickhouseSettings,
  updateTeamTelegramConfig,
} from '@/controllers/team';
import {
  deleteTeamMember,
  findUserByEmail,
  findUsersByTeam,
  reactivateTeamMember,
} from '@/controllers/user';
import { requirePermission } from '@/middleware/auth';
import AuditLog from '@/models/auditLog';
import Group from '@/models/group';
import Role from '@/models/role';
import TeamInvite from '@/models/teamInvite';
import User from '@/models/user';
import { registerWebhook, validateBotToken } from '@/services/telegram';
import { sendJson } from '@/utils/serialization';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

function getNonNullUserWithTeam(req: express.Request) {
  const user = req.user as any;
  const teamId = user?.team;
  const userId = user?._id;
  const email = user?.email;
  if (!teamId || !userId) {
    throw new Error('User must be authenticated with a team');
  }
  return { teamId, userId, email, user };
}

type TeamApiExpRes = express.Response<TeamApiResponse>;
router.get('/', async (req, res: TeamApiExpRes, next) => {
  try {
    const teamId = req.user?.team;
    const userId = req.user?._id;

    if (teamId == null) {
      throw new Error(`User ${req.user?._id} not associated with a team`);
    }
    if (userId == null) {
      throw new Error(`User has no id`);
    }

    const fields = [
      '_id',
      'allowedAuthMethods',
      'apiKey',
      'name',
      'createdAt',
    ] as const;
    const team = await getTeam(teamId, fields);
    if (team == null) {
      throw new Error(`Team ${teamId} not found for user ${userId}`);
    }

    sendJson(res, team);
  } catch (e) {
    next(e);
  }
});

type RotateApiKeyExpRes = express.Response<RotateApiKeyApiResponse>;
router.patch('/apiKey', async (req, res: RotateApiKeyExpRes, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      throw new Error(`User ${req.user?._id} not associated with a team`);
    }
    const team = await rotateTeamApiKey(teamId);
    if (team?.apiKey == null) {
      throw new Error(`Failed to rotate API key for team ${teamId}`);
    }
    res.json({ newApiKey: team.apiKey });
  } catch (e) {
    next(e);
  }
});

router.patch(
  '/name',
  validateRequest({
    body: z.object({
      name: z.string().min(1).max(100),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        throw new Error(`User ${req.user?._id} not associated with a team`);
      }
      const { name } = req.body;
      const team = await setTeamName(teamId, name);
      res.json({ name: team?.name });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  '/clickhouse-settings',
  processRequest({
    body: TeamClickHouseSettingsSchema,
  }),
  async (
    req,
    res: express.Response<UpdateClickHouseSettingsApiResponse>,
    next,
  ) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        throw new Error(`User ${req.user?._id} not associated with a team`);
      }

      if (Object.keys(req.body).length === 0) {
        return res.json({});
      }

      const team = await updateTeamClickhouseSettings(teamId, req.body);

      res.json(pick(team, Object.keys(req.body)));
    } catch (e) {
      next(e);
    }
  },
);

// GET /team/telegram-config
router.get('/telegram-config', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);
    const config = await getTeamTelegramConfig(teamId);
    // Never expose the full bot token to frontend — mask it
    if (config) {
      res.json({
        data: {
          botToken: config.botToken ? `${config.botToken.slice(0, 8)}...` : '',
          webhookUrl: config.webhookUrl,
          webhookSecret: '••••••••',
        },
      });
    } else {
      res.json({ data: null });
    }
  } catch (e) {
    next(e);
  }
});

// PUT /team/telegram-config
router.put(
  '/telegram-config',
  processRequest({
    body: TelegramConfigSchema,
  }),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);

      // Validate bot token before saving
      const tokenValidation = await validateBotToken(req.body.botToken);
      if (!tokenValidation.ok) {
        return res
          .status(400)
          .json({ error: `Invalid bot token: ${tokenValidation.error}` });
      }

      await updateTeamTelegramConfig(teamId, req.body);

      // Register webhook with Telegram
      const webhookResult = await registerWebhook(req.body);
      if (!webhookResult.ok) {
        return res.status(400).json({
          error: `Config saved but webhook registration failed: ${webhookResult.error}`,
        });
      }

      res.json({ data: { success: true, botName: tokenValidation.botName } });
    } catch (e) {
      next(e);
    }
  },
);

router.post(
  '/invitation',
  validateRequest({
    body: z.object({
      email: z.string().email(),
      name: z.string().optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const { email: toEmail, name } = req.body;
      const teamId = req.user?.team;
      const fromEmail = req.user?.email;

      if (teamId == null) {
        throw new Error(`User ${req.user?._id} not associated with a team`);
      }

      if (fromEmail == null) {
        throw new Error(`User ${req.user?._id} doesnt have email`);
      }

      const toUser = await findUserByEmail(toEmail);
      if (toUser) {
        return res.status(400).json({
          message:
            'User already exists. Please contact HyperDX team for support',
        });
      }

      // Normalize email to lowercase for consistency
      const normalizedEmail = toEmail.toLowerCase();

      // Check for existing invitation with normalized email
      let teamInvite = await TeamInvite.findOne({
        teamId,
        email: normalizedEmail,
      });

      if (!teamInvite) {
        teamInvite = await new TeamInvite({
          teamId,
          name,
          email: normalizedEmail,
          token: crypto.randomBytes(32).toString('hex'),
        }).save();
      }

      res.json({
        url: `${config.FRONTEND_URL}/join-team?token=${teamInvite.token}`,
      });
    } catch (e) {
      next(e);
    }
  },
);

type TeamInviteExpressRes = express.Response<TeamInvitationsApiResponse>;
router.get('/invitations', async (req, res: TeamInviteExpressRes, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      throw new Error(`User ${req.user?._id} not associated with a team`);
    }
    const teamInvites = await TeamInvite.find(
      { teamId },
      {
        createdAt: 1,
        email: 1,
        name: 1,
        token: 1,
      },
    );
    res.json({
      data: teamInvites.map(ti => ({
        _id: ti._id.toString(),
        createdAt: ti.createdAt.toISOString(),
        email: ti.email,
        name: ti.name,
        url: `${config.FRONTEND_URL}/join-team?token=${ti.token}`,
      })),
    });
  } catch (e) {
    next(e);
  }
});

router.delete(
  '/invitation/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const id = req.params.id;

      await TeamInvite.findByIdAndDelete(id);

      return res.json({ message: 'TeamInvite deleted' });
    } catch (e) {
      next(e);
    }
  },
);

type TeamMembersExpRes = express.Response<TeamMembersApiResponse>;
router.get('/members', async (req, res: TeamMembersExpRes, next) => {
  try {
    const teamId = req.user?.team;
    const userId = req.user?._id;
    if (teamId == null) {
      throw new Error(`User ${req.user?._id} not associated with a team`);
    }
    if (userId == null) {
      throw new Error(`User has no id`);
    }
    const [teamUsers, groups] = await Promise.all([
      findUsersByTeam(teamId).populate('roleId'),
      Group.find({ teamId }),
    ]);
    const groupMap = new Map(groups.map(g => [g._id.toString(), g.name]));
    res.json({
      data: teamUsers.map(user => {
        const userJson = user.toJSON({ virtuals: true });
        const groupId = (userJson as any).groupId?.toString();
        const role = (userJson as any).roleId;
        const roleId =
          role && typeof role === 'object'
            ? role._id?.toString()
            : role?.toString();
        const roleName =
          role && typeof role === 'object' ? role.name : undefined;
        return {
          ...pick(userJson, [
            '_id',
            'email',
            'name',
            'hasPasswordAuth',
            'authMethod',
          ]),
          isCurrentUser: user._id.equals(userId),
          isSuperAdmin: !!(userJson as any).isSuperAdmin,
          lastLoginAt: (userJson as any).lastLoginAt ?? null,
          disabledAt: (userJson as any).disabledAt ?? null,
          disabledReason: (userJson as any).disabledReason ?? null,
          ...(roleId && { roleId, roleName }),
          ...(groupId && {
            groupId,
            groupName: groupMap.get(groupId),
          }),
        };
      }),
    });
  } catch (e) {
    next(e);
  }
});

router.delete(
  '/member/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const userIdToDelete = req.params.id;
      const teamId = req.user?.team;
      if (teamId == null) {
        throw new Error(`User ${req.user?._id} not associated with a team`);
      }

      const userIdRequestingDelete = req.user?._id;
      if (!userIdRequestingDelete) {
        throw new Error(`Requesting user has no id`);
      }

      await deleteTeamMember(teamId, userIdToDelete, userIdRequestingDelete);

      res.json({ message: 'User deleted' });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  '/member/:id/reactivate',
  requirePermission('members:assign-group'),
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        throw new Error(`User ${req.user?._id} not associated with a team`);
      }

      await reactivateTeamMember(teamId, req.params.id);

      res.json({ message: 'User reactivated successfully' });
    } catch (e: any) {
      if (e.message === 'User not found in team') {
        return res.status(403).json({ message: 'Forbidden' });
      }
      if (e.message === 'User is not disabled') {
        return res.status(400).json({ message: 'User is not disabled' });
      }
      next(e);
    }
  },
);

type TeamTagsExpRes = express.Response<TeamTagsApiResponse>;
router.get('/tags', async (req, res: TeamTagsExpRes, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      throw new Error(`User ${req.user?._id} not associated with a team`);
    }
    const tags = await getTags(teamId);
    return res.json({ data: tags });
  } catch (e) {
    next(e);
  }
});

// ─── Group Routes ────────────────────────────────────────────────

router.get('/groups', async (req, res, next) => {
  try {
    const teamId = req.user?.team;
    if (teamId == null) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const groups = await Group.find({ teamId }).sort({ createdAt: -1 });
    res.json({
      data: groups.map(g => g.toJSON()),
    });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/group',
  validateRequest({
    body: z.object({
      name: z.string().min(1).max(100),
      accountAccess: z.enum(['read-only', 'read-write']).default('read-only'),
      dataScope: z
        .string()
        .max(500)
        .regex(
          /^([a-zA-Z0-9_.]+:[a-zA-Z0-9_.*-]+(\s+[a-zA-Z0-9_.]+:[a-zA-Z0-9_.*-]+)*)?$/,
          'Data scope must be in format "field:value" (e.g., "service:staging")',
        )
        .default(''),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const { name, accountAccess, dataScope } = req.body;
      const group = await new Group({
        name,
        teamId,
        accountAccess,
        dataScope,
      }).save();
      res.status(201).json({ data: group.toJSON() });
    } catch (e: any) {
      if (e?.code === 11000) {
        return res
          .status(409)
          .json({ message: 'A group with this name already exists' });
      }
      next(e);
    }
  },
);

router.patch(
  '/group/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
    body: z.object({
      name: z.string().min(1).max(100).optional(),
      accountAccess: z.enum(['read-only', 'read-write']).optional(),
      dataScope: z
        .string()
        .max(500)
        .regex(
          /^([a-zA-Z0-9_.]+:[a-zA-Z0-9_.*-]+(\s+[a-zA-Z0-9_.]+:[a-zA-Z0-9_.*-]+)*)?$/,
          'Data scope must be in format "field:value" (e.g., "service:staging")',
        )
        .optional(),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const group = await Group.findOneAndUpdate(
        { _id: req.params.id, teamId },
        { $set: req.body },
        { new: true },
      );
      if (!group) {
        return res.status(404).json({ message: 'Group not found' });
      }
      res.json({ data: group.toJSON() });
    } catch (e: any) {
      if (e?.code === 11000) {
        return res
          .status(409)
          .json({ message: 'A group with this name already exists' });
      }
      next(e);
    }
  },
);

router.delete(
  '/group/:id',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const group = await Group.findOneAndDelete({
        _id: req.params.id,
        teamId,
      });
      if (!group) {
        return res.status(404).json({ message: 'Group not found' });
      }
      // Unassign users from the deleted group
      await User.updateMany(
        { team: teamId, groupId: req.params.id },
        { $unset: { groupId: 1 } },
      );
      res.json({ message: 'Group deleted' });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  '/member/:id/group',
  validateRequest({
    params: z.object({
      id: objectIdSchema,
    }),
    body: z.object({
      groupId: z.string().nullable(),
    }),
  }),
  async (req, res, next) => {
    try {
      const teamId = req.user?.team;
      if (teamId == null) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      const { groupId } = req.body;
      // Verify the group belongs to this team (if assigning)
      if (groupId != null) {
        const group = await Group.findOne({ _id: groupId, teamId });
        if (!group) {
          return res.status(404).json({ message: 'Group not found' });
        }
      }
      const update =
        groupId != null ? { $set: { groupId } } : { $unset: { groupId: 1 } };
      const user = await User.findOneAndUpdate(
        { _id: req.params.id, team: teamId },
        update,
        { new: true },
      );
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json({ data: { _id: user._id, groupId: user.groupId ?? null } });
    } catch (e) {
      next(e);
    }
  },
);

// ─── Role Routes (RBAC) ─────────────────────────────────────────

router.get('/roles', async (req, res, next) => {
  try {
    const { teamId } = getNonNullUserWithTeam(req);
    const roles = await Role.find({
      $or: [{ teamId }, { teamId: null, isSystem: true }],
    }).sort({ isSystem: -1, name: 1 });
    res.json({ data: roles });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/role',
  requirePermission('roles:create'),
  async (req, res, next) => {
    try {
      const { teamId, userId, email } = getNonNullUserWithTeam(req);
      const { name, permissions, dataScopes } = req.body;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ message: 'Name is required' });
      }
      if (!Array.isArray(permissions)) {
        return res
          .status(400)
          .json({ message: 'Permissions must be an array' });
      }
      for (const p of permissions) {
        if (
          typeof p !== 'string' ||
          (!ALL_PERMISSIONS.includes(p as any) &&
            !p.endsWith(':*') &&
            p !== '*:*')
        ) {
          return res.status(400).json({ message: `Invalid permission: ${p}` });
        }
      }
      if (dataScopes && !Array.isArray(dataScopes)) {
        return res.status(400).json({ message: 'dataScopes must be an array' });
      }
      const scopeRegex = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
      for (const s of dataScopes ?? []) {
        if (!scopeRegex.test(s)) {
          return res.status(400).json({
            message: `Invalid data scope format: ${s}. Expected field:value`,
          });
        }
      }

      const role = await Role.create({
        name: name.trim(),
        teamId,
        permissions,
        dataScopes: dataScopes ?? [],
        isSystem: false,
      });

      await AuditLog.create({
        teamId,
        actorId: userId,
        actorEmail: email,
        action: 'role:created',
        targetType: 'role',
        targetId: role._id,
        details: { name: role.name, permissions, dataScopes },
      });

      res.json({ data: role });
    } catch (e: any) {
      if (e.code === 11000) {
        return res
          .status(400)
          .json({ message: 'A role with that name already exists' });
      }
      next(e);
    }
  },
);

router.patch(
  '/role/:id',
  requirePermission('roles:edit'),
  async (req, res, next) => {
    try {
      const { teamId, userId, email } = getNonNullUserWithTeam(req);
      const role = await Role.findOne({ _id: req.params.id, teamId });

      if (!role) {
        return res.status(404).json({ message: 'Role not found' });
      }
      if (role.isSystem) {
        return res
          .status(400)
          .json({ message: 'System roles cannot be modified' });
      }

      const { name, permissions, dataScopes } = req.body;
      const changes: Record<string, unknown> = {};

      if (name !== undefined) {
        role.name = name.trim();
        changes.name = name.trim();
      }
      if (permissions !== undefined) {
        role.permissions = permissions;
        changes.permissions = permissions;
      }
      if (dataScopes !== undefined) {
        const scopeRegex = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
        for (const s of dataScopes) {
          if (!scopeRegex.test(s)) {
            return res
              .status(400)
              .json({ message: `Invalid data scope: ${s}` });
          }
        }
        role.dataScopes = dataScopes;
        changes.dataScopes = dataScopes;
      }

      await role.save();

      await AuditLog.create({
        teamId,
        actorId: userId,
        actorEmail: email,
        action: 'role:updated',
        targetType: 'role',
        targetId: role._id,
        details: changes,
      });

      res.json({ data: role });
    } catch (e) {
      next(e);
    }
  },
);

router.delete(
  '/role/:id',
  requirePermission('roles:delete'),
  async (req, res, next) => {
    try {
      const { teamId, userId, email } = getNonNullUserWithTeam(req);
      const role = await Role.findOne({ _id: req.params.id, teamId });

      if (!role) {
        return res.status(404).json({ message: 'Role not found' });
      }
      if (role.isSystem) {
        return res
          .status(400)
          .json({ message: 'System roles cannot be deleted' });
      }

      const UserModel = mongoose.model('User');
      await UserModel.updateMany(
        { roleId: role._id },
        { $unset: { roleId: 1 } },
      );

      await role.deleteOne();

      await AuditLog.create({
        teamId,
        actorId: userId,
        actorEmail: email,
        action: 'role:deleted',
        targetType: 'role',
        targetId: role._id,
        details: { name: role.name },
      });

      res.json({ data: { ok: true } });
    } catch (e) {
      next(e);
    }
  },
);

// ─── Member Role & Permission Routes ────────────────────────────

router.patch(
  '/member/:id/role',
  requirePermission('members:assign-group'),
  async (req, res, next) => {
    try {
      const { teamId, userId, email } = getNonNullUserWithTeam(req);
      const { roleId } = req.body;
      const UserModel = mongoose.model('User');
      const targetUser = await UserModel.findOne({
        _id: req.params.id,
        team: teamId,
      });

      if (!targetUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      const previousRoleId = (targetUser as any).roleId;

      if (roleId) {
        const role = await Role.findOne({
          _id: roleId,
          $or: [{ teamId }, { teamId: null, isSystem: true }],
        });
        if (!role) {
          return res.status(400).json({ message: 'Role not found' });
        }
        (targetUser as any).roleId = role._id;
      } else {
        (targetUser as any).roleId = undefined;
      }

      await targetUser.save();

      await AuditLog.create({
        teamId,
        actorId: userId,
        actorEmail: email,
        action: 'role:assigned',
        targetType: 'user',
        targetId: targetUser._id,
        details: { from: previousRoleId, to: roleId },
      });

      res.json({ data: { ok: true } });
    } catch (e) {
      next(e);
    }
  },
);

router.patch(
  '/member/:id/permissions',
  requirePermission('roles:edit'),
  async (req, res, next) => {
    try {
      const { teamId, userId, email } = getNonNullUserWithTeam(req);
      const { grants, revokes } = req.body;
      const UserModel = mongoose.model('User');
      const targetUser = await UserModel.findOne({
        _id: req.params.id,
        team: teamId,
      });

      if (!targetUser) {
        return res.status(404).json({ message: 'User not found' });
      }

      (targetUser as any).permissionOverrides = {
        grants: grants ?? [],
        revokes: revokes ?? [],
      };
      await targetUser.save();

      await AuditLog.create({
        teamId,
        actorId: userId,
        actorEmail: email,
        action: 'permission:overrides-updated',
        targetType: 'user',
        targetId: targetUser._id,
        details: { grants, revokes },
      });

      res.json({ data: { ok: true } });
    } catch (e) {
      next(e);
    }
  },
);

// ─── Audit Log Routes ───────────────────────────────────────────

router.get(
  '/audit-log',
  requirePermission('roles:view'),
  async (req, res, next) => {
    try {
      const { teamId } = getNonNullUserWithTeam(req);
      const page = parseInt(req.query.page as string) || 0;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

      const [data, totalCount] = await Promise.all([
        AuditLog.find({ teamId })
          .sort({ createdAt: -1 })
          .skip(page * limit)
          .limit(limit),
        AuditLog.countDocuments({ teamId }),
      ]);

      res.json({ data, totalCount });
    } catch (e) {
      next(e);
    }
  },
);

// ─── Current User Permissions ───────────────────────────────────

router.get('/me/permissions', async (req, res, next) => {
  try {
    const user = req.user as any;
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (user.roleId && typeof user.roleId !== 'object') {
      await user.populate('roleId');
    }

    const role =
      user.roleId && typeof user.roleId === 'object' ? user.roleId : null;
    const permissions = user.isSuperAdmin
      ? ['*:*']
      : resolvePermissions(
          role?.permissions ?? [],
          user.permissionOverrides?.grants ?? [],
          user.permissionOverrides?.revokes ?? [],
        );

    res.json({
      permissions,
      dataScopes: role?.dataScopes ?? [],
      isSuperAdmin: user.isSuperAdmin ?? false,
      role: role
        ? { _id: role._id, name: role.name, isSystem: role.isSystem }
        : null,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
