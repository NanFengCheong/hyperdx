import { createContext, ReactNode, useContext, useMemo } from 'react';
import { hasPermission } from '@hyperdx/common-utils/dist/permissions';
import api from '../api';

interface PermissionContextValue {
  permissions: string[];
  dataScopes: string[];
  isSuperAdmin: boolean;
  roleName: string | null;
  isLoading: boolean;
  can: (permission: string) => boolean;
}

const PermissionContext = createContext<PermissionContextValue>({
  permissions: [],
  dataScopes: [],
  isSuperAdmin: false,
  roleName: null,
  isLoading: true,
  can: () => false,
});

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = api.useMyPermissions();

  const value = useMemo<PermissionContextValue>(() => {
    const permissions = data?.permissions ?? [];
    const isSuperAdmin = data?.isSuperAdmin ?? false;

    return {
      permissions,
      dataScopes: data?.dataScopes ?? [],
      isSuperAdmin,
      roleName: data?.role?.name ?? null,
      isLoading,
      can: (permission: string) => {
        if (isSuperAdmin) return true;
        return hasPermission(permissions, permission);
      },
    };
  }, [data, isLoading]);

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  );
}

export function usePermissions() {
  return useContext(PermissionContext);
}
