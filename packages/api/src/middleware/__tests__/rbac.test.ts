import {
  getResolvedPermissions,
  getUserDataScope,
  requirePermission,
  requireSuperAdmin,
  requireWriteAccess,
} from '@/middleware/auth';

describe('RBAC middleware', () => {
  describe('requireWriteAccess', () => {
    const makeReq = (method: string, user: Record<string, any> = {}): any => ({
      method,
      user: { ...user, _id: '1', email: 'test@test.com', team: '1' },
    });

    it('allows GET requests regardless of role/group', () => {
      const req = makeReq('GET');
      const res = {} as any;
      const next = jest.fn();
      requireWriteAccess(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('allows HEAD and OPTIONS requests regardless of role/group', () => {
      for (const method of ['HEAD', 'OPTIONS']) {
        const req = makeReq(method);
        const res = {} as any;
        const next = jest.fn();
        requireWriteAccess(req, res, next);
        expect(next).toHaveBeenCalled();
      }
    });

    it('blocks write requests for legacy read-only group users', () => {
      const group = { accountAccess: 'read-only', dataScope: '' } as any;
      const req = makeReq('POST', { groupId: group });
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();
      requireWriteAccess(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message:
          'Your group has read-only access. Write operations are not allowed.',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('allows write requests for legacy read-write group users', () => {
      const group = { accountAccess: 'read-write', dataScope: '' } as any;
      const req = makeReq('POST', { groupId: group });
      const res = {} as any;
      const next = jest.fn();
      requireWriteAccess(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('skips legacy group check when user has a populated role', () => {
      const role = {
        permissions: ['dashboards:view'],
        dataScopes: [],
      } as any;
      const group = { accountAccess: 'read-only', dataScope: '' } as any;
      const req = makeReq('POST', { roleId: role, groupId: group });
      const res = {} as any;
      const next = jest.fn();
      requireWriteAccess(req, res, next);
      // Role-based users skip the legacy group check — fine-grained permissions handle access
      expect(next).toHaveBeenCalled();
    });

    it('allows write requests when user has no group or role', () => {
      const req = makeReq('PUT', { groupId: undefined, roleId: undefined });
      const res = {} as any;
      const next = jest.fn();
      requireWriteAccess(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('getUserDataScope', () => {
    const makeReq = (user: Record<string, any> = {}): any => ({
      user: { ...user, _id: '1', email: 'test@test.com', team: '1' },
    });

    it('returns empty string for super admin', () => {
      const req = makeReq({ isSuperAdmin: true });
      expect(getUserDataScope(req)).toBe('');
    });

    it('returns data scopes from role', () => {
      const role = { dataScopes: ['service:api', 'level:error'] } as any;
      const req = makeReq({ roleId: role });
      expect(getUserDataScope(req)).toBe('service:api level:error');
    });

    it('falls back to group dataScope for legacy users', () => {
      const group = { dataScope: 'env:staging' } as any;
      const req = makeReq({ groupId: group });
      expect(getUserDataScope(req)).toBe('env:staging');
    });

    it('prefers role dataScope over group dataScope', () => {
      const role = { dataScopes: ['service:api'] } as any;
      const group = { dataScope: 'env:staging' } as any;
      const req = makeReq({ roleId: role, groupId: group });
      expect(getUserDataScope(req)).toBe('service:api');
    });

    it('returns empty string when no role or group', () => {
      const req = makeReq({});
      expect(getUserDataScope(req)).toBe('');
    });

    it('returns empty string when no user', () => {
      expect(getUserDataScope({ user: null } as any)).toBe('');
    });
  });

  describe('getResolvedPermissions', () => {
    const makeReq = (user: Record<string, any> = {}): any => ({
      user: { ...user, _id: '1', email: 'test@test.com', team: '1' },
    });

    it('returns *:* for super admin', () => {
      const req = makeReq({ isSuperAdmin: true });
      expect(getResolvedPermissions(req)).toEqual(['*:*']);
    });

    it('returns role permissions when no overrides', () => {
      const role = {
        permissions: ['dashboards:view', 'alerts:create'],
      } as any;
      const req = makeReq({ roleId: role });
      const result = getResolvedPermissions(req);
      expect(result).toContain('dashboards:view');
      expect(result).toContain('alerts:create');
      expect(result.length).toBe(2);
    });

    it('adds grants to role permissions', () => {
      const role = { permissions: ['dashboards:view'] } as any;
      const req = makeReq({
        roleId: role,
        permissionOverrides: { grants: ['alerts:delete'], revokes: [] },
      });
      const result = getResolvedPermissions(req);
      expect(result).toContain('dashboards:view');
      expect(result).toContain('alerts:delete');
    });

    it('removes revokes from effective permissions', () => {
      const role = {
        permissions: ['dashboards:view', 'dashboards:edit', 'alerts:create'],
      } as any;
      const req = makeReq({
        roleId: role,
        permissionOverrides: {
          grants: [],
          revokes: ['dashboards:edit'],
        },
      });
      const result = getResolvedPermissions(req);
      expect(result).toContain('dashboards:view');
      expect(result).not.toContain('dashboards:edit');
      expect(result).toContain('alerts:create');
    });

    it('returns empty array when no role', () => {
      const req = makeReq({ roleId: undefined });
      expect(getResolvedPermissions(req)).toEqual([]);
    });

    it('returns empty array when no user', () => {
      expect(getResolvedPermissions({ user: null } as any)).toEqual([]);
    });
  });

  describe('requirePermission', () => {
    const makeReq = (user: Record<string, any> = {}): any => ({
      user: { ...user, _id: '1', email: 'test@test.com', team: '1' },
    });

    it('passes for super admin', () => {
      const req = makeReq({ isSuperAdmin: true });
      const res = {} as any;
      const next = jest.fn();
      const middleware = requirePermission('dashboards:delete');
      middleware(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('passes when user has exact permission', () => {
      const role = { permissions: ['dashboards:create'] } as any;
      const req = makeReq({ roleId: role });
      const res = {} as any;
      const next = jest.fn();
      requirePermission('dashboards:create')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('passes when user has resource:* wildcard', () => {
      const role = { permissions: ['dashboards:*'] } as any;
      const req = makeReq({ roleId: role });
      const res = {} as any;
      const next = jest.fn();
      requirePermission('dashboards:delete')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('passes when user has *:* wildcard', () => {
      const role = { permissions: ['*:*'] } as any;
      const req = makeReq({ roleId: role });
      const res = {} as any;
      const next = jest.fn();
      requirePermission('anything:you:want')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when permission is missing', () => {
      const role = { permissions: ['dashboards:view'] } as any;
      const req = makeReq({ roleId: role });
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();
      requirePermission('alerts:delete')(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message: "Forbidden: missing permission 'alerts:delete'",
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no user', () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();
      requirePermission('dashboards:view')({ user: null } as any, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('respects permission overrides (grants)', () => {
      const role = { permissions: ['dashboards:view'] } as any;
      const req = makeReq({
        roleId: role,
        permissionOverrides: {
          grants: ['alerts:delete'],
          revokes: [],
        },
      });
      const res = {} as any;
      const next = jest.fn();
      requirePermission('alerts:delete')(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('respects permission overrides (revokes)', () => {
      const role = {
        permissions: ['dashboards:view', 'dashboards:edit'],
      } as any;
      const req = makeReq({
        roleId: role,
        permissionOverrides: {
          grants: [],
          revokes: ['dashboards:edit'],
        },
      });
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();
      requirePermission('dashboards:edit')(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('requireSuperAdmin', () => {
    const makeReq = (user: Record<string, any> = {}): any => ({
      user: { ...user, _id: '1', email: 'test@test.com', team: '1' },
    });

    it('passes for super admin', () => {
      const req = makeReq({ isSuperAdmin: true });
      const res = {} as any;
      const next = jest.fn();
      requireSuperAdmin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 for non-super-admin', () => {
      const req = makeReq({ isSuperAdmin: false });
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();
      requireSuperAdmin(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        message: 'Forbidden: super admin required',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 when no user', () => {
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();
      requireSuperAdmin({ user: null } as any, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
