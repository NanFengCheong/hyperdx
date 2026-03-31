import { usePermissions } from '../contexts/PermissionContext';

export function usePermission(permission: string): boolean {
  const { can } = usePermissions();
  return can(permission);
}

export function useIsSuperAdmin(): boolean {
  const { isSuperAdmin } = usePermissions();
  return isSuperAdmin;
}
