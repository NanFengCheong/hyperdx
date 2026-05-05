import Router from 'next/router';
import type { HTTPError, Options, ResponsePromise } from 'ky';
import ky from 'ky-universal';
import type {
  Alert,
  AlertsApiResponse,
  InstallationApiResponse,
  MeApiResponse,
  PresetDashboard,
  PresetDashboardFilter,
  RotateApiKeyApiResponse,
  TeamApiResponse,
  TeamInvitationsApiResponse,
  TeamMembersApiResponse,
  TeamTagsApiResponse,
  UpdateClickHouseSettingsApiResponse,
  WebhookCreateApiResponse,
  WebhooksApiResponse,
  WebhookTestApiResponse,
  WebhookUpdateApiResponse,
} from '@hyperdx/common-utils/dist/types';
import type { UseQueryOptions } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { IS_LOCAL_MODE } from './config';
import {
  Dashboard,
  fetchLocalDashboards,
  getLocalDashboardTags,
} from './dashboard';
type ServicesResponse = {
  data: Record<
    string,
    Array<{
      'deployment.environment'?: string;
      'k8s.namespace.name'?: string;
      'k8s.pod.name'?: string;
      'k8s.pod.uid'?: string;
    }>
  >;
};

function loginHook(request: Request, options: any, response: Response) {
  // marketing pages
  const WHITELIST_PATHS = [
    '/',
    '/forgot',
    '/join-team',
    '/login',
    '/register',
    '/reset-password',
    '/verify',
    '/auth/oidc/callback',
  ];
  if (!WHITELIST_PATHS.includes(Router.pathname) && response.status === 401) {
    try {
      window.sessionStorage.setItem('hdx-login-redirect-url', Router.asPath);
    } catch (e: any) {
      console.error(e);
    }
    Router.push('/login');
  }
}

const server = ky.create({
  prefixUrl: '/api',
  credentials: 'include',
  hooks: {
    afterResponse: [loginHook],
  },
  timeout: false,
});

export const hdxServer = (
  url: string,
  options?: Options | undefined,
): ResponsePromise => {
  return server(url, {
    ...options,
  });
};

const api = {
  useCreateAlert() {
    return useMutation<{ data: Alert }, Error, Alert>({
      mutationFn: async alert =>
        server('alerts', {
          method: 'POST',
          json: alert,
        }).json(),
    });
  },
  useUpdateAlert() {
    return useMutation<{ data: Alert }, Error, { id: string } & Alert>({
      mutationFn: async alert =>
        server(`alerts/${alert.id}`, {
          method: 'PUT',
          json: alert,
        }).json(),
    });
  },
  useDeleteAlert() {
    return useMutation<void, Error, string>({
      mutationFn: async (alertId: string) => {
        await server(`alerts/${alertId}`, {
          method: 'DELETE',
        });
      },
    });
  },
  useSilenceAlert() {
    return useMutation<void, Error, { alertId: string; mutedUntil: string }>({
      mutationFn: async ({ alertId, mutedUntil }) => {
        await server(`alerts/${alertId}/silenced`, {
          method: 'POST',
          json: { mutedUntil },
        });
      },
    });
  },
  useUnsilenceAlert() {
    return useMutation<void, Error, string>({
      mutationFn: async (alertId: string) => {
        await server(`alerts/${alertId}/silenced`, {
          method: 'DELETE',
        });
      },
    });
  },
  useDashboards(options?: UseQueryOptions<Dashboard[] | null, Error>) {
    return useQuery({
      queryKey: [`dashboards`],
      queryFn: IS_LOCAL_MODE
        ? async () => fetchLocalDashboards()
        : () => hdxServer(`dashboards`, { method: 'GET' }).json<Dashboard[]>(),
      ...options,
    });
  },
  useCreateDashboard() {
    return useMutation({
      mutationFn: async ({
        name,
        charts,
        query,
        tags,
      }: {
        name: string;
        charts: Dashboard['tiles'];
        query: string;
        tags: string[];
      }) =>
        hdxServer(`dashboards`, {
          method: 'POST',
          json: { name, charts, query, tags },
        }).json<Dashboard>(),
    });
  },
  useUpdateDashboard() {
    return useMutation({
      mutationFn: async ({
        id,
        name,
        charts,
        query,
        tags,
      }: {
        id: string;
        name: string;
        charts: Dashboard['tiles'];
        query: string;
        tags: string[];
      }) =>
        hdxServer(`dashboards/${id}`, {
          method: 'PUT',
          json: { name, charts, query, tags },
        }).json<Dashboard>(),
    });
  },
  useDeleteDashboard() {
    return useMutation({
      mutationFn: async ({ id }: { id: string }) => {
        await hdxServer(`dashboards/${id}`, {
          method: 'DELETE',
        });
      },
    });
  },
  usePresetDashboardFilters(
    presetDashboard: PresetDashboard,
    sourceId: string,
    enabled: boolean = true,
  ) {
    return useQuery({
      queryKey: [`dashboards`, `preset`, presetDashboard, `filters`, sourceId],
      queryFn: () =>
        hdxServer(`dashboards/preset/${presetDashboard}/filters/`, {
          method: 'GET',
          searchParams: { sourceId },
        }).json<PresetDashboardFilter[]>(),
      enabled: !!sourceId && enabled,
    });
  },
  useCreatePresetDashboardFilter() {
    return useMutation<PresetDashboardFilter, Error, PresetDashboardFilter>({
      mutationFn: async (filter: PresetDashboardFilter) =>
        hdxServer(`dashboards/preset/${filter.presetDashboard}/filter`, {
          method: 'POST',
          json: { filter },
        }).json<PresetDashboardFilter>(),
    });
  },
  useUpdatePresetDashboardFilter() {
    return useMutation<PresetDashboardFilter, Error, PresetDashboardFilter>({
      mutationFn: async (filter: PresetDashboardFilter) =>
        hdxServer(`dashboards/preset/${filter.presetDashboard}/filter`, {
          method: 'PUT',
          json: { filter },
        }).json<PresetDashboardFilter>(),
    });
  },
  useDeletePresetDashboardFilter() {
    return useMutation<
      PresetDashboardFilter,
      Error,
      { id: string; presetDashboard: PresetDashboard }
    >({
      mutationFn: async ({
        id,
        presetDashboard,
      }: {
        id: string;
        presetDashboard: PresetDashboard;
      }) =>
        hdxServer(`dashboards/preset/${presetDashboard}/filter/${id}`, {
          method: 'DELETE',
        }).json<PresetDashboardFilter>(),
    });
  },
  useAlerts() {
    return useQuery({
      queryKey: [`alerts`],
      queryFn: () => hdxServer(`alerts`).json<AlertsApiResponse>(),
    });
  },
  useCreateAlertInvestigation() {
    const queryClient = useQueryClient();
    return useMutation<{ _id: string }, Error | HTTPError, { alertId: string }>(
      {
        mutationFn: ({ alertId }) =>
          hdxServer(`investigations/from-alert`, {
            method: 'POST',
            json: { alertId },
          }).json(),
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['investigations'] });
        },
      },
    );
  },
  useServices() {
    return useQuery({
      queryKey: [`services`],
      queryFn: () =>
        hdxServer(`chart/services`, {
          method: 'GET',
        }).json<ServicesResponse>(),
    });
  },
  useRotateTeamApiKey() {
    return useMutation<RotateApiKeyApiResponse, Error | HTTPError>({
      mutationFn: async () =>
        hdxServer(`team/apiKey`, {
          method: 'PATCH',
        }).json<RotateApiKeyApiResponse>(),
    });
  },
  useDeleteTeamMember() {
    return useMutation<
      { message: string },
      Error | HTTPError,
      { userId: string }
    >({
      mutationFn: async ({ userId }: { userId: string }) =>
        hdxServer(`team/member/${userId}`, {
          method: 'DELETE',
        }).json<{ message: string }>(),
    });
  },
  useReactivateTeamMember() {
    return useMutation<
      { message: string },
      Error | HTTPError,
      { userId: string }
    >({
      mutationFn: async ({ userId }: { userId: string }) =>
        hdxServer(`team/member/${userId}/reactivate`, {
          method: 'PATCH',
        }).json<{ message: string }>(),
    });
  },
  useTeamInvitations() {
    return useQuery<TeamInvitationsApiResponse>({
      queryKey: [`team/invitations`],
      queryFn: () =>
        hdxServer(`team/invitations`).json<TeamInvitationsApiResponse>(),
    });
  },
  useSaveTeamInvitation() {
    return useMutation<
      { url: string },
      Error | HTTPError,
      { name?: string; email: string }
    >({
      mutationFn: async ({ name, email }: { name?: string; email: string }) =>
        hdxServer(`team/invitation`, {
          method: 'POST',
          json: {
            name,
            email,
          },
        }).json<{ url: string }>(),
    });
  },
  useDeleteTeamInvitation() {
    return useMutation({
      mutationFn: async ({ id }: { id: string }) =>
        hdxServer(`team/invitation/${id}`, {
          method: 'DELETE',
        }).json<{ message: string }>(),
    });
  },
  useAuthConfig() {
    return useQuery<
      { isTeamExisting: boolean; oidcEnabled: boolean } | undefined,
      Error
    >({
      queryKey: ['auth/config'],
      queryFn: () => {
        if (IS_LOCAL_MODE) {
          return undefined;
        }
        return hdxServer('auth/config').json<{
          isTeamExisting: boolean;
          oidcEnabled: boolean;
        }>();
      },
    });
  },
  useInstallation() {
    return useQuery<InstallationApiResponse | undefined, Error>({
      queryKey: [`installation`],
      queryFn: () => {
        if (IS_LOCAL_MODE) {
          return;
        }
        return hdxServer(`installation`).json<InstallationApiResponse>();
      },
    });
  },
  useMe() {
    return useQuery<MeApiResponse | null>({
      queryKey: [`me`],
      queryFn: () => {
        if (IS_LOCAL_MODE) {
          return null;
        }
        return hdxServer(`me`).json<MeApiResponse>();
      },
    });
  },
  useTeam() {
    return useQuery({
      queryKey: [`team`],
      queryFn: () => {
        if (IS_LOCAL_MODE) {
          return null;
        }
        return hdxServer(`team`).json<TeamApiResponse>();
      },
      retry: 1,
    });
  },
  useTeamMembers() {
    return useQuery<TeamMembersApiResponse>({
      queryKey: [`team/members`],
      queryFn: () => hdxServer(`team/members`).json<TeamMembersApiResponse>(),
    });
  },
  useSetTeamName() {
    return useMutation<{ name: string }, HTTPError, { name: string }>({
      mutationFn: async ({ name }) =>
        hdxServer(`team/name`, {
          method: 'PATCH',
          json: { name },
        }).json<{ name: string }>(),
    });
  },
  useUpdateClickhouseSettings() {
    return useMutation<
      UpdateClickHouseSettingsApiResponse,
      HTTPError,
      {
        searchRowLimit?: number;
        fieldMetadataDisabled?: boolean;
        metadataMaxRowsToRead?: number;
      }
    >({
      mutationFn: async settings =>
        hdxServer(`team/clickhouse-settings`, {
          method: 'PATCH',
          json: settings,
        }).json<UpdateClickHouseSettingsApiResponse>(),
    });
  },
  useTags() {
    return useQuery({
      queryKey: [`team/tags`],
      queryFn: IS_LOCAL_MODE
        ? async () => ({ data: getLocalDashboardTags() })
        : () => hdxServer(`team/tags`).json<TeamTagsApiResponse>(),
    });
  },
  useTeamGroups() {
    return useQuery({
      queryKey: [`team/groups`],
      queryFn: () => hdxServer(`team/groups`).json<{ data: any[] }>(),
    });
  },
  useCreateGroup() {
    return useMutation<
      any,
      Error | HTTPError,
      {
        name: string;
        accountAccess: 'read-only' | 'read-write';
        dataScope?: string;
      }
    >({
      mutationFn: async body =>
        hdxServer(`team/group`, {
          method: 'POST',
          json: body,
        }).json(),
    });
  },
  useUpdateGroup() {
    return useMutation<
      any,
      Error | HTTPError,
      {
        id: string;
        name?: string;
        accountAccess?: 'read-only' | 'read-write';
        dataScope?: string;
      }
    >({
      mutationFn: async ({ id, ...body }) =>
        hdxServer(`team/group/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          json: body,
        }).json(),
    });
  },
  useDeleteGroup() {
    return useMutation<any, Error | HTTPError, { id: string }>({
      mutationFn: async ({ id }) =>
        hdxServer(`team/group/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).json(),
    });
  },
  useAssignMemberGroup() {
    return useMutation<
      any,
      Error | HTTPError,
      { userId: string; groupId: string | null }
    >({
      mutationFn: async ({ userId, groupId }) =>
        hdxServer(`team/member/${encodeURIComponent(userId)}/group`, {
          method: 'PATCH',
          json: { groupId },
        }).json(),
    });
  },
  useMyPermissions() {
    return useQuery({
      queryKey: ['team/me/permissions'],
      queryFn: () =>
        hdxServer('team/me/permissions').json<{
          permissions: string[];
          dataScopes: string[];
          isSuperAdmin: boolean;
          role: { _id: string; name: string; isSystem: boolean } | null;
        }>(),
    });
  },
  useTeamRoles() {
    return useQuery({
      queryKey: ['team/roles'],
      queryFn: () => hdxServer('team/roles').json<{ data: any[] }>(),
    });
  },
  useCreateRole() {
    return useMutation<
      any,
      Error | HTTPError,
      {
        name: string;
        permissions: string[];
        dataScopes?: string[];
      }
    >({
      mutationFn: async body =>
        hdxServer('team/role', { method: 'POST', json: body }).json(),
    });
  },
  useUpdateRole() {
    return useMutation<
      any,
      Error | HTTPError,
      {
        id: string;
        name?: string;
        permissions?: string[];
        dataScopes?: string[];
      }
    >({
      mutationFn: async ({ id, ...body }) =>
        hdxServer(`team/role/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          json: body,
        }).json(),
    });
  },
  useDeleteRole() {
    return useMutation<any, Error | HTTPError, { id: string }>({
      mutationFn: async ({ id }) =>
        hdxServer(`team/role/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }).json(),
    });
  },
  useAssignMemberRole() {
    return useMutation<
      any,
      Error | HTTPError,
      {
        userId: string;
        roleId: string | null;
      }
    >({
      mutationFn: async ({ userId, roleId }) =>
        hdxServer(`team/member/${encodeURIComponent(userId)}/role`, {
          method: 'PATCH',
          json: { roleId },
        }).json(),
    });
  },
  useUpdateMemberPermissions() {
    return useMutation<
      any,
      Error | HTTPError,
      {
        userId: string;
        grants: string[];
        revokes: string[];
      }
    >({
      mutationFn: async ({ userId, grants, revokes }) =>
        hdxServer(`team/member/${encodeURIComponent(userId)}/permissions`, {
          method: 'PATCH',
          json: { grants, revokes },
        }).json(),
    });
  },
  useTeamAuditLog(
    page = 0,
    limit = 50,
    filters?: {
      actorEmail?: string;
      action?: string;
      targetType?: string;
      targetId?: string;
      fromDate?: string;
      toDate?: string;
      search?: string;
    },
  ) {
    return useQuery({
      queryKey: ['team/audit-log', page, limit, filters],
      queryFn: () => {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(limit),
        });
        if (filters?.actorEmail) params.set('actorEmail', filters.actorEmail);
        if (filters?.action) params.set('action', filters.action);
        if (filters?.targetType) params.set('targetType', filters.targetType);
        if (filters?.targetId) params.set('targetId', filters.targetId);
        if (filters?.fromDate) params.set('fromDate', filters.fromDate);
        if (filters?.toDate) params.set('toDate', filters.toDate);
        if (filters?.search) params.set('search', filters.search);
        return hdxServer(`team/audit-log?${params}`).json<{
          data: any[];
          totalCount: number;
          page: number;
          limit: number;
        }>();
      },
    });
  },
  useTeamAuditLogActions() {
    return useQuery({
      queryKey: ['team/audit-log/actions'],
      queryFn: () =>
        hdxServer('team/audit-log/actions').json<{ data: string[] }>(),
      staleTime: 60_000,
    });
  },
  useTeamNotificationLog(
    page = 0,
    limit = 50,
    filters?: {
      channel?: string;
      status?: string;
      recipient?: string;
      triggerType?: string;
      triggerId?: string;
      fromDate?: string;
      toDate?: string;
      search?: string;
    },
  ) {
    return useQuery({
      queryKey: ['team/notification-log', page, limit, filters],
      queryFn: () => {
        const params = new URLSearchParams({
          page: String(page),
          limit: String(limit),
        });
        if (filters?.channel) params.set('channel', filters.channel);
        if (filters?.status) params.set('status', filters.status);
        if (filters?.recipient) params.set('recipient', filters.recipient);
        if (filters?.triggerType)
          params.set('triggerType', filters.triggerType);
        if (filters?.triggerId) params.set('triggerId', filters.triggerId);
        if (filters?.fromDate) params.set('fromDate', filters.fromDate);
        if (filters?.toDate) params.set('toDate', filters.toDate);
        if (filters?.search) params.set('search', filters.search);
        return hdxServer(`team/notification-log?${params}`).json<{
          data: any[];
          totalCount: number;
          page: number;
          limit: number;
        }>();
      },
    });
  },
  useRetryNotification() {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (id: string) =>
        hdxServer(`team/notification-log/${id}/retry`, {
          method: 'POST',
        }).json<{ data: any }>(),
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: ['team/notification-log'],
        });
      },
    });
  },
  useSaveWebhook() {
    return useMutation<
      WebhookCreateApiResponse,
      Error | HTTPError,
      {
        service: string;
        url: string;
        name: string;
        description: string;
        queryParams?: Record<string, string>;
        headers?: Record<string, string>;
        body?: string;
      }
    >({
      mutationFn: async ({
        service,
        url,
        name,
        description,
        queryParams,
        headers,
        body,
      }) =>
        hdxServer(`webhooks`, {
          method: 'POST',
          json: {
            name,
            service,
            url,
            description,
            queryParams: queryParams || {},
            headers: headers || {},
            body,
          },
        }).json<WebhookCreateApiResponse>(),
    });
  },
  useUpdateWebhook() {
    return useMutation<
      WebhookUpdateApiResponse,
      Error | HTTPError,
      {
        id: string;
        service: string;
        url: string;
        name: string;
        description: string;
        queryParams?: Record<string, string>;
        headers?: Record<string, string>;
        body?: string;
      }
    >({
      mutationFn: async ({
        id,
        service,
        url,
        name,
        description,
        queryParams,
        headers,
        body,
      }) =>
        hdxServer(`webhooks/${id}`, {
          method: 'PUT',
          json: {
            name,
            service,
            url,
            description,
            queryParams: queryParams || {},
            headers: headers || {},
            body,
          },
        }).json<WebhookUpdateApiResponse>(),
    });
  },
  useWebhooks(services: string[]) {
    return useQuery<WebhooksApiResponse, Error>({
      queryKey: [...services],
      queryFn: () =>
        hdxServer('webhooks', {
          method: 'GET',
          searchParams: [...services.map(service => ['service', service])],
        }).json<WebhooksApiResponse>(),
    });
  },
  useDeleteWebhook() {
    return useMutation<
      Record<string, never>,
      Error | HTTPError,
      { id: string }
    >({
      mutationFn: async ({ id }: { id: string }) =>
        hdxServer(`webhooks/${id}`, {
          method: 'DELETE',
        }).json(),
    });
  },
  useTestWebhook() {
    return useMutation<
      WebhookTestApiResponse,
      Error | HTTPError,
      {
        service: string;
        url: string;
        queryParams?: Record<string, string>;
        headers?: Record<string, string>;
        body?: string;
      }
    >({
      mutationFn: async ({ service, url, queryParams, headers, body }) =>
        hdxServer(`webhooks/test`, {
          method: 'POST',
          json: {
            service,
            url,
            queryParams: queryParams || {},
            headers: headers || {},
            body,
          },
        }).json<WebhookTestApiResponse>(),
    });
  },
  useRegisterPassword() {
    return useMutation<
      { status: string },
      Error,
      { email: string; password: string; confirmPassword: string }
    >({
      mutationFn: async ({ email, password, confirmPassword }) =>
        hdxServer(`register/password`, {
          method: 'POST',
          json: {
            email,
            password,
            confirmPassword,
          },
        }).json<{ status: string }>(),
    });
  },
  useVerifyOtp() {
    return useMutation<{ status: string }, Error, { code: string }>({
      mutationFn: async ({ code }) =>
        hdxServer('verify-otp', {
          method: 'POST',
          json: { code },
        }).json<{ status: string }>(),
    });
  },
  useResendOtp() {
    return useMutation<{ status: string }, Error, void>({
      mutationFn: async () =>
        hdxServer('resend-otp', {
          method: 'POST',
        }).json<{ status: string }>(),
    });
  },
  useForgotPassword() {
    return useMutation<{ status: string }, Error, { email: string }>({
      mutationFn: async ({ email }) =>
        hdxServer('forgot-password', {
          method: 'POST',
          json: { email },
        }).json<{ status: string }>(),
    });
  },
  useResetPassword() {
    return useMutation<
      { status: string },
      Error,
      {
        email: string;
        code?: string;
        token?: string;
        password: string;
        confirmPassword: string;
      }
    >({
      mutationFn: async data =>
        hdxServer('reset-password', {
          method: 'POST',
          json: data,
        }).json<{ status: string }>(),
    });
  },
  useTestConnection() {
    return useMutation<
      { success: boolean; error?: string },
      Error,
      { host: string; username: string; password: string }
    >({
      mutationFn: async ({ host, username, password }) =>
        hdxServer(`clickhouse-proxy/test`, {
          method: 'POST',
          json: {
            host,
            username,
            password,
          },
        }).json<{ success: boolean; error?: string }>(),
    });
  },
  useTelegramConfig() {
    return useQuery({
      queryKey: ['team', 'telegram-config'],
      queryFn: () =>
        hdxServer('team/telegram-config', { method: 'GET' }).json<{
          data: {
            botToken: string;
            webhookUrl: string;
            webhookSecret: string;
          } | null;
        }>(),
    });
  },
  useUpdateTelegramConfig() {
    return useMutation({
      mutationFn: (config: {
        botToken: string;
        webhookUrl: string;
        webhookSecret?: string;
      }) =>
        hdxServer('team/telegram-config', {
          method: 'PUT',
          json: config,
        }).json(),
    });
  },
};
export default api;

// ---------------------------------------------------------------------------
// Platform Admin API hooks
// ---------------------------------------------------------------------------
export const useAdminTeams = () =>
  useQuery<{ data: any[] }>({
    queryKey: ['admin', 'teams'],
    queryFn: () => hdxServer('admin/teams').json(),
  });

export const useAdminTeamMembers = (teamId: string | null) =>
  useQuery<{ data: any[] }>({
    queryKey: ['admin', 'team-members', teamId],
    queryFn: () =>
      hdxServer(`admin/team/${encodeURIComponent(teamId!)}/members`).json(),
    enabled: !!teamId,
  });

export const useToggleSuperAdmin = () =>
  useMutation<any, Error, { userId: string; isSuperAdmin: boolean }>({
    mutationFn: ({ userId, isSuperAdmin }) =>
      hdxServer(`admin/user/${encodeURIComponent(userId)}/super-admin`, {
        method: 'PATCH',
        json: { isSuperAdmin },
      }).json(),
  });

export const useAdminAuditLog = (
  page: number,
  limit: number,
  filters?: { fromDate?: string; toDate?: string; actorEmail?: string },
) =>
  useQuery<{ data: any[]; totalCount: number; page: number; limit: number }>({
    queryKey: ['admin', 'audit-log', page, limit, filters],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (filters?.fromDate) params.set('fromDate', filters.fromDate);
      if (filters?.toDate) params.set('toDate', filters.toDate);
      if (filters?.actorEmail) params.set('actorEmail', filters.actorEmail);
      return hdxServer(`admin/audit-log?${params}`).json();
    },
  });

export const useAdminNotificationLog = (
  page: number,
  limit: number,
  filters?: {
    teamId?: string;
    channel?: string;
    status?: string;
    recipient?: string;
    triggerType?: string;
    fromDate?: string;
    toDate?: string;
    search?: string;
  },
) =>
  useQuery<{ data: any[]; totalCount: number; page: number; limit: number }>({
    queryKey: ['admin', 'notification-log', page, limit, filters],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (filters?.teamId) params.set('teamId', filters.teamId);
      if (filters?.channel) params.set('channel', filters.channel);
      if (filters?.status) params.set('status', filters.status);
      if (filters?.recipient) params.set('recipient', filters.recipient);
      if (filters?.triggerType) params.set('triggerType', filters.triggerType);
      if (filters?.fromDate) params.set('fromDate', filters.fromDate);
      if (filters?.toDate) params.set('toDate', filters.toDate);
      if (filters?.search) params.set('search', filters.search);
      return hdxServer(`admin/notification-log?${params}`).json();
    },
  });

export const useAdminRetryNotification = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      hdxServer(`admin/notification-log/${id}/retry`, {
        method: 'POST',
      }).json<{ data: any }>(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'notification-log'],
      });
    },
  });
};

export const useAdminNotificationLogRetention = () =>
  useQuery<{ retentionDays: number }>({
    queryKey: ['admin', 'notification-log', 'retention'],
    queryFn: () =>
      hdxServer('admin/notification-log/retention').json<{
        retentionDays: number;
      }>(),
  });

export const useUpdateAdminNotificationLogRetention = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (retentionDays: number) =>
      hdxServer('admin/notification-log/retention', {
        method: 'PUT',
        json: { retentionDays },
      }).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'notification-log', 'retention'],
      });
    },
  });
};

export const useRunDataRetention = () =>
  useMutation<
    { data: { ok: boolean; dryRun: boolean } },
    Error,
    { dryRun: boolean }
  >({
    mutationFn: ({ dryRun }) =>
      hdxServer('admin/data-retention/run', {
        method: 'POST',
        json: { dryRun },
      }).json(),
  });

export const useDataRetentionSettings = () =>
  useQuery<{ data: { auditLog: number; alertHistory: number } }>({
    queryKey: ['admin', 'data-retention-settings'],
    queryFn: () => hdxServer('admin/data-retention/settings').json(),
  });

export const useUpdateDataRetentionSettings = () =>
  useMutation<
    { data: { ok: boolean } },
    Error,
    { auditLog: number; alertHistory: number }
  >({
    mutationFn: settings =>
      hdxServer('admin/data-retention/settings', {
        method: 'PUT',
        json: settings,
      }).json(),
  });

export type ClickhouseRetentionSettings = {
  maxDiskGB: number;
  enabled: boolean;
  targetUsagePercent: number;
};

export type ClickhouseRetentionStatus = {
  diskSizeGB: string;
  totalSizeGB: string;
  freeDiskGB: string;
  maxDiskGB: number;
  enabled: boolean;
  usagePercent: string;
  targetUsagePercent: number;
  thresholdGB: string;
  isOverThreshold: boolean;
  tables: Array<{
    database: string;
    table: string;
    sizeGB: string;
    oldestPartition: string | null;
    newestPartition: string | null;
    partitionCount: number;
  }>;
};

export const useClickhouseRetentionSettings = () =>
  useQuery<{ data: ClickhouseRetentionSettings }>({
    queryKey: ['admin', 'clickhouse-retention-settings'],
    queryFn: () => hdxServer('admin/clickhouse-retention/settings').json(),
  });

export const useUpdateClickhouseRetentionSettings = () =>
  useMutation<
    { data: { ok: boolean } },
    Error,
    { maxDiskGB: number; enabled: boolean }
  >({
    mutationFn: settings =>
      hdxServer('admin/clickhouse-retention/settings', {
        method: 'PUT',
        json: settings,
      }).json(),
  });

export const useClickhouseRetentionStatus = () =>
  useQuery<{ data: ClickhouseRetentionStatus }>({
    queryKey: ['admin', 'clickhouse-retention-status'],
    queryFn: () => hdxServer('admin/clickhouse-retention/status').json(),
    refetchInterval: 60_000,
  });

export const useRunClickhouseRetention = () =>
  useMutation<
    { data: { ok: boolean; dryRun: boolean } },
    Error,
    { dryRun: boolean }
  >({
    mutationFn: ({ dryRun }) =>
      hdxServer('admin/clickhouse-retention/run', {
        method: 'POST',
        json: { dryRun },
      }).json(),
  });

export const useProactiveInvestigationSettings = () =>
  useQuery<{ data: any }>({
    queryKey: ['admin', 'proactive-investigation-settings'],
    queryFn: () => hdxServer('admin/settings/proactive-investigation').json(),
  });

export const useUpdateProactiveInvestigationSettings = () =>
  useMutation<{ data: any }, Error, any>({
    mutationFn: settings =>
      hdxServer('admin/settings/proactive-investigation', {
        method: 'PATCH',
        json: settings,
      }).json(),
  });
