import type {
  RotateApiKeyApiResponse,
  TeamApiResponse,
  TeamInvitationsApiResponse,
  TeamMembersApiResponse,
  TeamTagsApiResponse,
  UpdateClickHouseSettingsApiResponse,
} from '@hyperdx/common-utils/dist/types';
import { TeamClickHouseSettingsSchema } from '@hyperdx/common-utils/dist/types';
import crypto from 'crypto';
import express from 'express';
import pick from 'lodash/pick';
import { z } from 'zod';
import { processRequest, validateRequest } from 'zod-express-middleware';

import * as config from '@/config';
import {
  getTags,
  getTeam,
  rotateTeamApiKey,
  setTeamName,
  updateTeamClickhouseSettings,
} from '@/controllers/team';
import {
  deleteTeamMember,
  findUserByEmail,
  findUsersByTeam,
} from '@/controllers/user';
import Group from '@/models/group';
import TeamInvite from '@/models/teamInvite';
import User from '@/models/user';
import { sendJson } from '@/utils/serialization';
import { objectIdSchema } from '@/utils/zod';

const router = express.Router();

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
      findUsersByTeam(teamId),
      Group.find({ teamId }),
    ]);
    const groupMap = new Map(groups.map(g => [g._id.toString(), g.name]));
    res.json({
      data: teamUsers.map(user => {
        const userJson = user.toJSON({ virtuals: true });
        const groupId = (userJson as any).groupId?.toString();
        return {
          ...pick(userJson, [
            '_id',
            'email',
            'name',
            'hasPasswordAuth',
            'authMethod',
          ]),
          isCurrentUser: user._id.equals(userId),
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

export default router;
