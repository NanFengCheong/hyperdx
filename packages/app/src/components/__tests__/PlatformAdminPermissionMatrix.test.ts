import { summarizePermissionCategory } from '@/components/PlatformAdminPermissionMatrix';

describe('summarizePermissionCategory', () => {
  const permissions = ['alerts:view', 'alerts:create', 'alerts:delete'];

  it('resolves role permissions with user grants and revokes', () => {
    expect(
      summarizePermissionCategory(
        {
          isSuperAdmin: false,
          roleId: {
            permissions: ['alerts:view', 'alerts:create'],
          },
          permissionOverrides: {
            grants: ['alerts:delete'],
            revokes: ['alerts:create'],
          },
        },
        permissions,
      ),
    ).toEqual({ enabled: 2, total: 3 });
  });

  it('gives super admins every permission', () => {
    expect(
      summarizePermissionCategory(
        {
          isSuperAdmin: true,
          roleId: null,
        },
        permissions,
      ),
    ).toEqual({ enabled: 3, total: 3 });
  });
});
