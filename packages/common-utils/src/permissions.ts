export const PERMISSIONS = {
  DASHBOARDS_VIEW: 'dashboards:view',
  DASHBOARDS_CREATE: 'dashboards:create',
  DASHBOARDS_EDIT: 'dashboards:edit',
  DASHBOARDS_DELETE: 'dashboards:delete',

  ALERTS_VIEW: 'alerts:view',
  ALERTS_CREATE: 'alerts:create',
  ALERTS_EDIT: 'alerts:edit',
  ALERTS_DELETE: 'alerts:delete',
  ALERTS_SILENCE: 'alerts:silence',

  SEARCHES_VIEW: 'searches:view',
  SEARCHES_CREATE: 'searches:create',
  SEARCHES_EDIT: 'searches:edit',
  SEARCHES_DELETE: 'searches:delete',

  EXPLORER_VIEW: 'explorer:view',
  EXPLORER_QUERY: 'explorer:query',

  SESSIONS_VIEW: 'sessions:view',

  SERVICEMAP_VIEW: 'servicemap:view',

  SOURCES_VIEW: 'sources:view',
  SOURCES_CREATE: 'sources:create',
  SOURCES_EDIT: 'sources:edit',
  SOURCES_DELETE: 'sources:delete',

  CONNECTIONS_VIEW: 'connections:view',
  CONNECTIONS_CREATE: 'connections:create',
  CONNECTIONS_EDIT: 'connections:edit',
  CONNECTIONS_DELETE: 'connections:delete',

  APIKEYS_VIEW: 'apikeys:view',
  APIKEYS_CREATE: 'apikeys:create',
  APIKEYS_ROTATE: 'apikeys:rotate',
  APIKEYS_DELETE: 'apikeys:delete',

  WEBHOOKS_VIEW: 'webhooks:view',
  WEBHOOKS_CREATE: 'webhooks:create',
  WEBHOOKS_EDIT: 'webhooks:edit',
  WEBHOOKS_DELETE: 'webhooks:delete',

  MEMBERS_VIEW: 'members:view',
  MEMBERS_INVITE: 'members:invite',
  MEMBERS_REMOVE: 'members:remove',
  MEMBERS_ASSIGN_GROUP: 'members:assign-group',

  ROLES_VIEW: 'roles:view',
  ROLES_CREATE: 'roles:create',
  ROLES_EDIT: 'roles:edit',
  ROLES_DELETE: 'roles:delete',

  SECURITY_VIEW: 'security:view',
  SECURITY_EDIT: 'security:edit',

  QUERYSETTINGS_VIEW: 'querysettings:view',
  QUERYSETTINGS_EDIT: 'querysettings:edit',

  INTEGRATIONS_VIEW: 'integrations:view',
  INTEGRATIONS_MANAGE: 'integrations:manage',

  PLATFORM_ADMIN: 'platform:admin',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const PERMISSION_CATEGORIES = [
  {
    label: 'Dashboards',
    permissions: [
      PERMISSIONS.DASHBOARDS_VIEW,
      PERMISSIONS.DASHBOARDS_CREATE,
      PERMISSIONS.DASHBOARDS_EDIT,
      PERMISSIONS.DASHBOARDS_DELETE,
    ],
  },
  {
    label: 'Alerts',
    permissions: [
      PERMISSIONS.ALERTS_VIEW,
      PERMISSIONS.ALERTS_CREATE,
      PERMISSIONS.ALERTS_EDIT,
      PERMISSIONS.ALERTS_DELETE,
      PERMISSIONS.ALERTS_SILENCE,
    ],
  },
  {
    label: 'Saved Searches',
    permissions: [
      PERMISSIONS.SEARCHES_VIEW,
      PERMISSIONS.SEARCHES_CREATE,
      PERMISSIONS.SEARCHES_EDIT,
      PERMISSIONS.SEARCHES_DELETE,
    ],
  },
  {
    label: 'Explorer',
    permissions: [PERMISSIONS.EXPLORER_VIEW, PERMISSIONS.EXPLORER_QUERY],
  },
  {
    label: 'Sessions',
    permissions: [PERMISSIONS.SESSIONS_VIEW],
  },
  {
    label: 'Service Map',
    permissions: [PERMISSIONS.SERVICEMAP_VIEW],
  },
  {
    label: 'Sources',
    permissions: [
      PERMISSIONS.SOURCES_VIEW,
      PERMISSIONS.SOURCES_CREATE,
      PERMISSIONS.SOURCES_EDIT,
      PERMISSIONS.SOURCES_DELETE,
    ],
  },
  {
    label: 'Connections',
    permissions: [
      PERMISSIONS.CONNECTIONS_VIEW,
      PERMISSIONS.CONNECTIONS_CREATE,
      PERMISSIONS.CONNECTIONS_EDIT,
      PERMISSIONS.CONNECTIONS_DELETE,
    ],
  },
  {
    label: 'API Keys',
    permissions: [
      PERMISSIONS.APIKEYS_VIEW,
      PERMISSIONS.APIKEYS_CREATE,
      PERMISSIONS.APIKEYS_ROTATE,
      PERMISSIONS.APIKEYS_DELETE,
    ],
  },
  {
    label: 'Webhooks',
    permissions: [
      PERMISSIONS.WEBHOOKS_VIEW,
      PERMISSIONS.WEBHOOKS_CREATE,
      PERMISSIONS.WEBHOOKS_EDIT,
      PERMISSIONS.WEBHOOKS_DELETE,
    ],
  },
  {
    label: 'Team Members',
    permissions: [
      PERMISSIONS.MEMBERS_VIEW,
      PERMISSIONS.MEMBERS_INVITE,
      PERMISSIONS.MEMBERS_REMOVE,
      PERMISSIONS.MEMBERS_ASSIGN_GROUP,
    ],
  },
  {
    label: 'Roles & Permissions',
    permissions: [
      PERMISSIONS.ROLES_VIEW,
      PERMISSIONS.ROLES_CREATE,
      PERMISSIONS.ROLES_EDIT,
      PERMISSIONS.ROLES_DELETE,
    ],
  },
  {
    label: 'Security Policies',
    permissions: [PERMISSIONS.SECURITY_VIEW, PERMISSIONS.SECURITY_EDIT],
  },
  {
    label: 'Query Settings',
    permissions: [
      PERMISSIONS.QUERYSETTINGS_VIEW,
      PERMISSIONS.QUERYSETTINGS_EDIT,
    ],
  },
  {
    label: 'Integrations',
    permissions: [PERMISSIONS.INTEGRATIONS_VIEW, PERMISSIONS.INTEGRATIONS_MANAGE],
  },
] as const;

export const SYSTEM_ROLES = {
  SUPER_ADMIN: {
    name: 'Super Admin',
    permissions: [PERMISSIONS.PLATFORM_ADMIN],
    dataScopes: [] as string[],
  },
  ADMIN: {
    name: 'Admin',
    permissions: ALL_PERMISSIONS.filter(p => p !== PERMISSIONS.PLATFORM_ADMIN),
    dataScopes: [] as string[],
  },
  EDITOR: {
    name: 'Editor',
    permissions: [
      ...ALL_PERMISSIONS.filter(p => p.endsWith(':view')),
      ...ALL_PERMISSIONS.filter(p => p.endsWith(':create')),
      ...ALL_PERMISSIONS.filter(p => p.endsWith(':edit')),
      PERMISSIONS.EXPLORER_QUERY,
      PERMISSIONS.ALERTS_SILENCE,
      PERMISSIONS.APIKEYS_ROTATE,
      PERMISSIONS.INTEGRATIONS_MANAGE,
    ],
    dataScopes: [] as string[],
  },
  VIEWER: {
    name: 'Viewer',
    permissions: [
      ...ALL_PERMISSIONS.filter(p => p.endsWith(':view')),
      PERMISSIONS.EXPLORER_QUERY,
    ],
    dataScopes: [] as string[],
  },
} as const;

export function hasPermission(
  userPermissions: string[],
  required: string,
): boolean {
  if (userPermissions.includes('*:*')) return true;
  if (userPermissions.includes(required)) return true;

  const [resource] = required.split(':');
  if (userPermissions.includes(`${resource}:*`)) return true;

  return false;
}

export function resolvePermissions(
  rolePermissions: string[],
  grants: string[] = [],
  revokes: string[] = [],
): string[] {
  const effective = new Set([...rolePermissions, ...grants]);
  for (const r of revokes) {
    effective.delete(r);
  }
  return Array.from(effective);
}
