import {
  hasPermission,
  resolvePermissions,
} from '@hyperdx/common-utils/dist/permissions';
import { Connection } from '@hyperdx/common-utils/dist/types';
import { setTraceAttributes } from '@hyperdx/node-opentelemetry';
import type { NextFunction, Request, Response } from 'express';
import { serializeError } from 'serialize-error';

import * as config from '@/config';
import { findUserByAccessKey } from '@/controllers/user';
import type { UserDocument } from '@/models/user';
import User from '@/models/user';
import logger from '@/utils/logger';

declare global {
  namespace Express {
    interface User extends UserDocument {}
  }
  namespace Express {
    interface Request {
      _hdx_connection?: Connection;
    }
  }
}

declare module 'express-session' {
  interface Session {
    messages: string[]; // Set by passport
    passport: { user: string }; // Set by passport
    pendingAuth?: {
      userId: string;
      verified: false;
    };
  }
}

export async function redirectToDashboard(req: Request, res: Response) {
  if (req?.user?.team) {
    // Block disabled users before updating lastLoginAt
    if (req.user.disabledAt != null) {
      req.logout(() => {});
      return res.redirect(`${config.FRONTEND_URL}/login?err=authFail`);
    }
    // Update lastLoginAt on successful password login
    await User.findByIdAndUpdate(req.user._id, { lastLoginAt: new Date() });
    return res.redirect(`${config.FRONTEND_URL}/search`);
  } else {
    logger.error(
      { userId: req?.user?._id },
      'Password login for user failed, user or team not found',
    );
    res.redirect(`${config.FRONTEND_URL}/login?err=unknown`);
  }
}

export function handleAuthError(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  logger.debug({ authErr: serializeError(err) }, 'Auth error');
  if (res.headersSent) {
    return next(err);
  }

  // Get the latest auth error message
  const lastMessage = req.session.messages?.at(-1);
  logger.debug(`Auth error last message: ${lastMessage}`);

  const returnErr =
    lastMessage === 'Password or username is incorrect'
      ? 'authFail'
      : lastMessage ===
          'Authentication method password is not allowed by your team admin.'
        ? 'passwordAuthNotAllowed'
        : 'unknown';

  res.redirect(`${config.FRONTEND_URL}/login?err=${returnErr}`);
}

export async function validateUserAccessKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.sendStatus(401);
  }
  const key = authHeader.split('Bearer ')[1];
  if (!key) {
    return res.sendStatus(401);
  }

  const user = await findUserByAccessKey(key);
  if (!user) {
    return res.sendStatus(401);
  }

  req.user = user;

  // After finding the user, populate their group and role
  if (user.groupId) {
    await user.populate('groupId');
  }
  if (user.roleId) {
    await user.populate('roleId');
  }

  next();
}

export async function isUserAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (config.IS_LOCAL_APP_MODE) {
    // If local app mode is enabled, skip authentication
    logger.warn('Skipping authentication in local app mode');
    req.user = {
      // @ts-ignore
      _id: '_local_user_',
      email: 'local-user@hyperdx.io',
      // @ts-ignore
      team: '_local_team_',
    };
    return next();
  }

  // Block pending 2FA sessions from accessing protected routes
  if (req.session.pendingAuth && !req.session.pendingAuth.verified) {
    return res.sendStatus(401);
  }

  if (req.isAuthenticated()) {
    // Block disabled users from accessing the application
    if (req.user?.disabledAt != null) {
      req.logout(() => {});
      return res.sendStatus(401);
    }

    // set user id as trace attribute
    setTraceAttributes({
      userId: req.user?._id.toString(),
      userEmail: req.user?.email,
    });

    // Populate role for session-authenticated users
    if (req.user && (req.user as any).roleId) {
      await (req.user as any).populate('roleId');
    }

    return next();
  }
  res.sendStatus(401);
}

export function getUserDataScope(req: Request): string {
  const user = req.user as any;
  if (!user) return '';

  // Super admin sees everything
  if (user.isSuperAdmin) return '';

  const role = user.roleId;
  if (role && typeof role === 'object' && Array.isArray(role.dataScopes)) {
    return role.dataScopes.join(' ');
  }

  // Backwards compatibility: check old group.dataScope
  const group = user.groupId;
  if (group && typeof group === 'object' && group.dataScope) {
    return group.dataScope;
  }

  return '';
}

export function getNonNullUserWithTeam(req: Request) {
  const user = req.user;

  if (!user) {
    throw new Error('User is not authenticated');
  }

  if (!user.team) {
    throw new Error(`User ${user._id} is not associated with a team`);
  }

  return { teamId: user.team, userId: user._id, email: user.email };
}

export function requireWriteAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Allow read operations for all users
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const user = req.user as any;

  // If user has a role (new RBAC system), skip legacy group check.
  // Fine-grained requirePermission() guards on each route handle access control.
  if (user?.roleId && typeof user.roleId === 'object') {
    return next();
  }

  // Check if user belongs to a read-only group (legacy)
  const group = user?.groupId;
  if (
    group &&
    typeof group === 'object' &&
    'accountAccess' in group &&
    group.accountAccess === 'read-only'
  ) {
    return res.status(403).json({
      message:
        'Your group has read-only access. Write operations are not allowed.',
    });
  }
  next();
}

export function getResolvedPermissions(req: Request): string[] {
  const user = req.user as any;
  if (!user) return [];

  if (user.isSuperAdmin) return ['*:*'];

  const role = user.roleId;
  if (!role || typeof role !== 'object') return [];

  return resolvePermissions(
    role.permissions ?? [],
    user.permissionOverrides?.grants ?? [],
    user.permissionOverrides?.revokes ?? [],
  );
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as any;
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (user.isSuperAdmin) {
      return next();
    }

    const resolved = getResolvedPermissions(req);
    if (hasPermission(resolved, permission)) {
      return next();
    }

    return res.status(403).json({
      message: `Forbidden: missing permission '${permission}'`,
    });
  };
}

export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const user = req.user as any;
  if (!user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  if (!user.isSuperAdmin) {
    return res.status(403).json({ message: 'Forbidden: super admin required' });
  }
  return next();
}
