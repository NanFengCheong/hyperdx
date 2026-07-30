import { Fragment, useCallback, useState } from 'react';
import Head from 'next/head';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Container,
  Group,
  Loader,
  Modal,
  NumberInput,
  Pagination,
  Paper,
  Progress,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconRefresh,
  IconSearch,
  IconShieldLock,
  IconTrash,
  IconUserPlus,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';

import PlatformAdminPermissionMatrix from './components/PlatformAdminPermissionMatrix';
import RolesSection from './components/TeamSettings/RolesSection';
import { useIsSuperAdmin } from './hooks/usePermission';
import { useBrandDisplayName } from './theme/ThemeProvider';
import {
  useAdminAuditLog,
  useAdminInviteUser,
  useAdminNotificationLog,
  useAdminNotificationLogRetention,
  useAdminRetryNotification,
  useAdminTeamMembers,
  useAdminTeamRoles,
  useAdminTeams,
  useClickhouseRetentionSettings,
  useClickhouseRetentionStatus,
  useDataRetentionSettings,
  useProactiveInvestigationSettings,
  useRunClickhouseRetention,
  useRunDataRetention,
  useToggleSuperAdmin,
  useUpdateAdminNotificationLogRetention,
  useUpdateClickhouseRetentionSettings,
  useUpdateDataRetentionSettings,
  useUpdateProactiveInvestigationSettings,
} from './api';
import { withAppNav } from './layout';

function AccessDenied() {
  return (
    <Center h="60vh">
      <Stack align="center" gap="sm">
        <IconShieldLock size={48} opacity={0.3} />
        <Title order={3}>Access Denied</Title>
        <Text c="dimmed" size="sm">
          You do not have permission to access this page. Platform Admin is
          restricted to super administrators.
        </Text>
      </Stack>
    </Center>
  );
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleString();
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// Team Members sub-table
// ---------------------------------------------------------------------------
function TeamMembersTable({ teamId }: { teamId: string }) {
  const { data, isLoading } = useAdminTeamMembers(teamId);
  const toggleSuperAdmin = useToggleSuperAdmin();
  const queryClient = useQueryClient();
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const handleToggle = useCallback(
    (userId: string, currentValue: boolean) => {
      const action = currentValue ? 'revoke' : 'grant';
      if (
        !window.confirm(
          `Are you sure you want to ${action} super admin for this user?`,
        )
      ) {
        return;
      }
      setPendingUserId(userId);
      toggleSuperAdmin.mutate(
        { userId, isSuperAdmin: !currentValue },
        {
          onSettled: () => {
            setPendingUserId(null);
            queryClient.invalidateQueries({
              queryKey: ['admin', 'team-members', teamId],
            });
          },
        },
      );
    },
    [toggleSuperAdmin, queryClient, teamId],
  );

  if (isLoading) {
    return (
      <Center py="md">
        <Loader size="sm" />
      </Center>
    );
  }

  const members = data?.data ?? [];

  if (members.length === 0) {
    return (
      <Text c="dimmed" size="sm" py="xs" pl="xl">
        No members found.
      </Text>
    );
  }

  return (
    <>
      <Table
        highlightOnHover
        withTableBorder={false}
        withColumnBorders={false}
        ml="xl"
        mb="sm"
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Email</Table.Th>
            <Table.Th>Name</Table.Th>
            <Table.Th>Role</Table.Th>
            <Table.Th>Super Admin</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {members.map((m: any) => (
            <Table.Tr key={m._id ?? m.email}>
              <Table.Td>
                <Text size="sm">{m.email}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{m.name || '—'}</Text>
              </Table.Td>
              <Table.Td>
                {m.roleId?.name ? (
                  <Badge variant="light" size="sm">
                    {m.roleId.name}
                  </Badge>
                ) : (
                  <Text c="dimmed" size="sm">
                    —
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Switch
                  size="sm"
                  checked={!!m.isSuperAdmin}
                  disabled={pendingUserId === (m._id ?? m.email)}
                  onChange={() =>
                    handleToggle(m._id ?? m.email, !!m.isSuperAdmin)
                  }
                  label={
                    m.isSuperAdmin ? (
                      <Badge color="red" variant="filled" size="xs">
                        Super Admin
                      </Badge>
                    ) : null
                  }
                />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <PlatformAdminPermissionMatrix members={members} />
    </>
  );
}

function InviteUserModal({
  onClose,
  team,
}: {
  onClose: () => void;
  team: { _id: string; name: string };
}) {
  const [email, setEmail] = useState('');
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [roleId, setRoleId] = useState<string | null>(null);
  const { data: roles, isLoading: rolesLoading } = useAdminTeamRoles(team._id);
  const inviteUser = useAdminInviteUser();

  const submit = () => {
    inviteUser.mutate(
      {
        email,
        isSuperAdmin,
        roleId: roleId || undefined,
        teamId: team._id,
      },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: `Invitation sent to ${email}`,
          });
          onClose();
        },
        onError: error => {
          notifications.show({
            color: 'red',
            message: error.message,
          });
        },
      },
    );
  };

  return (
    <Modal opened onClose={onClose} title={`Invite user to ${team.name}`}>
      <Stack>
        <TextInput
          required
          type="email"
          label="Email"
          value={email}
          onChange={event => setEmail(event.currentTarget.value)}
        />
        <Select
          clearable
          searchable
          disabled={rolesLoading}
          label="Team role"
          placeholder="Viewer (default)"
          value={roleId}
          onChange={setRoleId}
          data={(roles?.data ?? []).map((role: any) => ({
            label: role.name,
            value: role._id,
          }))}
        />
        <Switch
          checked={isSuperAdmin}
          label="Grant global Super Admin access"
          onChange={event => setIsSuperAdmin(event.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!email}
            loading={inviteUser.isPending}
            onClick={submit}
          >
            Send invitation
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Teams Tab
// ---------------------------------------------------------------------------
function TeamsPanel() {
  const { data, isLoading } = useAdminTeams();
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [inviteTeam, setInviteTeam] = useState<{
    _id: string;
    name: string;
  } | null>(null);

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  const teams = data?.data ?? [];

  if (teams.length === 0) {
    return (
      <Text c="dimmed" py="xl" ta="center">
        No teams found.
      </Text>
    );
  }

  return (
    <>
      <Table highlightOnHover withTableBorder withColumnBorders={false}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={40} />
            <Table.Th>Team Name</Table.Th>
            <Table.Th>Created</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {teams.map((team: any) => {
            const isExpanded = expandedTeamId === team._id;
            return (
              <Table.Tr key={team._id} style={{ cursor: 'pointer' }}>
                <Table.Td colSpan={4} p={0}>
                  <Table withTableBorder={false} withColumnBorders={false}>
                    <Table.Tbody>
                      <Table.Tr
                        onClick={() =>
                          setExpandedTeamId(isExpanded ? null : team._id)
                        }
                      >
                        <Table.Td w={40}>
                          <ActionIcon variant="subtle" size="sm">
                            {isExpanded ? (
                              <IconChevronDown size={16} />
                            ) : (
                              <IconChevronRight size={16} />
                            )}
                          </ActionIcon>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {team.name}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {team.createdAt ? formatDate(team.createdAt) : '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Button
                            leftSection={<IconUserPlus size={14} />}
                            size="xs"
                            variant="secondary"
                            onClick={event => {
                              event.stopPropagation();
                              setInviteTeam(team);
                            }}
                          >
                            Invite
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                      <Table.Tr>
                        <Table.Td colSpan={4} p={0}>
                          <Box>
                            {isExpanded && (
                              <TeamMembersTable teamId={team._id} />
                            )}
                          </Box>
                        </Table.Td>
                      </Table.Tr>
                    </Table.Tbody>
                  </Table>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
      {inviteTeam && (
        <InviteUserModal
          key={inviteTeam._id}
          team={inviteTeam}
          onClose={() => setInviteTeam(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit Log action badge color mapping
// ---------------------------------------------------------------------------
function actionColor(action: string): string {
  if (action.startsWith('create') || action.startsWith('add')) return 'green';
  if (action.startsWith('delete') || action.startsWith('remove')) return 'red';
  if (action.startsWith('update') || action.startsWith('edit')) return 'blue';
  if (action.includes('super') || action.includes('admin')) return 'orange';
  return 'gray';
}

// ---------------------------------------------------------------------------
// Audit Log description formatter
// ---------------------------------------------------------------------------
function formatAuditDescription(log: any): string {
  const parts: string[] = [];

  if (log.targetType) {
    parts.push(log.targetType);
  }

  if (log.targetEmail) {
    parts.push(log.targetEmail);
  } else if (log.targetName) {
    parts.push(log.targetName);
  }

  if (typeof log.details === 'object' && log.details != null) {
    const detail = log.details as Record<string, unknown>;

    // Show meaningful detail values, preferring emails/names over IDs
    const fromLabel = detail.fromEmail ?? detail.fromName ?? detail.from;
    const toLabel = detail.toEmail ?? detail.toName ?? detail.to;

    if (fromLabel && toLabel) {
      parts.push(`from "${fromLabel}" to "${toLabel}"`);
    } else if (toLabel) {
      parts.push(`→ ${toLabel}`);
    } else if (fromLabel) {
      parts.push(`from "${fromLabel}"`);
    }

    // Include any remaining human-readable keys
    for (const [k, v] of Object.entries(detail)) {
      if (
        ['from', 'to', 'fromEmail', 'toEmail', 'fromName', 'toName'].includes(k)
      )
        continue;
      if (typeof v === 'string' && v.length < 80) {
        parts.push(`${k}: ${v}`);
      }
    }
  }

  return parts.join(' — ') || '—';
}

// ---------------------------------------------------------------------------
// Audit Log Tab
// ---------------------------------------------------------------------------
const AUDIT_PAGE_SIZE = 50;

function AuditLogPanel() {
  const [page, setPage] = useState(0);
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [actorFilter, setActorFilter] = useState('');

  const filters = {
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
    actorEmail: actorFilter || undefined,
  };

  const { data, isLoading } = useAdminAuditLog(page, AUDIT_PAGE_SIZE, filters);

  const logs = data?.data ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / AUDIT_PAGE_SIZE));

  const handleFilterReset = () => {
    setFromDate(null);
    setToDate(null);
    setActorFilter('');
    setPage(0);
  };

  const hasActiveFilters = fromDate || toDate || actorFilter;

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (logs.length === 0) {
    return (
      <Text c="dimmed" py="xl" ta="center">
        No audit log entries found.
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {/* Filters */}
      <Group grow>
        <DatePickerInput
          label="From Date"
          placeholder="Select start date"
          value={fromDate ? fromDate.toISOString().slice(0, 10) : null}
          onChange={value => setFromDate(value ? new Date(value) : null)}
          clearable
          size="sm"
        />
        <DatePickerInput
          label="To Date"
          placeholder="Select end date"
          value={toDate ? toDate.toISOString().slice(0, 10) : null}
          onChange={value => setToDate(value ? new Date(value) : null)}
          clearable
          size="sm"
        />
        <TextInput
          label="Actor Email"
          placeholder="Filter by actor email..."
          value={actorFilter}
          onChange={e => setActorFilter(e.currentTarget.value)}
          size="sm"
        />
      </Group>
      {hasActiveFilters && (
        <Group justify="flex-end">
          <Button variant="subtle" size="xs" onClick={handleFilterReset}>
            Clear Filters
          </Button>
        </Group>
      )}

      <Table highlightOnHover withTableBorder withColumnBorders={false}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Timestamp</Table.Th>
            <Table.Th>Actor</Table.Th>
            <Table.Th>Action</Table.Th>
            <Table.Th>Description</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {logs.map((log: any, idx: number) => (
            <Table.Tr key={log._id ?? idx}>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {log.createdAt ? formatDate(log.createdAt) : '—'}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{log.actorEmail || '—'}</Text>
              </Table.Td>
              <Table.Td>
                <Badge
                  variant="light"
                  color={actionColor(log.action ?? '')}
                  size="sm"
                >
                  {log.action}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Text size="sm">{formatAuditDescription(log)}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Group justify="center">
        <Pagination
          total={totalPages}
          value={page + 1}
          onChange={v => setPage(v - 1)}
        />
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Notification Log Tab
// ---------------------------------------------------------------------------
const NOTIF_LOG_PAGE_SIZE = 50;

const NOTIF_STATUS_COLORS: Record<string, string> = {
  pending: 'yellow',
  success: 'green',
  failed: 'red',
};

const NOTIF_CHANNEL_OPTIONS = [
  { value: '', label: 'All Channels' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
];

const NOTIF_STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
];

function NotificationLogPanel() {
  const [page, setPage] = useState(0);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [recipient, setRecipient] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = {
    channel: channel || undefined,
    status: status || undefined,
    recipient: recipient || undefined,
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
    search: search || undefined,
  };

  const { data, isLoading } = useAdminNotificationLog(
    page,
    NOTIF_LOG_PAGE_SIZE,
    filters,
  );
  const retryMutation = useAdminRetryNotification();
  const { data: retention } = useAdminNotificationLogRetention();
  const updateRetention = useUpdateAdminNotificationLogRetention();

  const logs = data?.data ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / NOTIF_LOG_PAGE_SIZE));

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '\u2014';
    return new Date(dateStr).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleRetry = (id: string) => {
    retryMutation.mutate(id);
  };

  const resetFilters = () => {
    setChannel('');
    setStatus('');
    setRecipient('');
    setSearch('');
    setFromDate(null);
    setToDate(null);
    setPage(0);
  };

  const handleSaveRetention = (days: number) => {
    if (days >= 1) {
      updateRetention.mutate(days);
    }
  };

  return (
    <Stack gap="md">
      {/* Retention Settings */}
      <Group grow>
        <NumberInput
          label="Retention (days)"
          value={(retention as any)?.retentionDays ?? 30}
          onChange={v => handleSaveRetention(Number(v))}
          min={1}
          size="sm"
        />
      </Group>

      {/* Filters */}
      <Group grow>
        <Select
          label="Channel"
          placeholder="All Channels"
          data={NOTIF_CHANNEL_OPTIONS}
          value={channel}
          onChange={v => {
            setChannel(v ?? '');
            setPage(0);
          }}
          clearable
          size="sm"
        />
        <Select
          label="Status"
          placeholder="All Statuses"
          data={NOTIF_STATUS_OPTIONS}
          value={status}
          onChange={v => {
            setStatus(v ?? '');
            setPage(0);
          }}
          clearable
          size="sm"
        />
        <TextInput
          label="Recipient"
          placeholder="Filter by recipient..."
          value={recipient}
          onChange={e => {
            setRecipient(e.currentTarget.value);
            setPage(0);
          }}
          size="sm"
        />
        <TextInput
          label="Search"
          placeholder="Search subject/recipient..."
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={e => {
            setSearch(e.currentTarget.value);
            setPage(0);
          }}
          size="sm"
        />
      </Group>
      <Group>
        <DatePickerInput
          label="From Date"
          placeholder="Select start date"
          value={fromDate ? fromDate.toISOString().slice(0, 10) : null}
          onChange={v => {
            setFromDate(v ? new Date(v) : null);
            setPage(0);
          }}
          clearable
          size="sm"
        />
        <DatePickerInput
          label="To Date"
          placeholder="Select end date"
          value={toDate ? toDate.toISOString().slice(0, 10) : null}
          onChange={v => {
            setToDate(v ? new Date(v) : null);
            setPage(0);
          }}
          clearable
          size="sm"
        />
        {(channel || status || recipient || search || fromDate || toDate) && (
          <Button
            variant="subtle"
            size="xs"
            onClick={resetFilters}
            style={{ alignSelf: 'flex-end' }}
          >
            Clear Filters
          </Button>
        )}
      </Group>

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : logs.length === 0 ? (
        <Text c="dimmed" py="xl" ta="center">
          No notification log entries found.
        </Text>
      ) : (
        <>
          <Table highlightOnHover withTableBorder withColumnBorders={false}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={30} />
                <Table.Th>Date</Table.Th>
                <Table.Th>Channel</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Recipient</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th>Trigger</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {logs.map((entry: any) => (
                <Fragment key={entry._id}>
                  <Table.Tr
                    onClick={() =>
                      setExpandedId(expandedId === entry._id ? null : entry._id)
                    }
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      {expandedId === entry._id ? (
                        <IconChevronUp size={14} />
                      ) : (
                        <IconChevronDown size={14} />
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{formatDate(entry.createdAt)}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge size="sm" variant="light">
                        {entry.channel}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        size="sm"
                        color={NOTIF_STATUS_COLORS[entry.status] ?? 'gray'}
                      >
                        {entry.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" truncate maw={200}>
                        {entry.recipient}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" truncate maw={200}>
                        {entry.subject ?? '\u2014'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{entry.trigger?.name ?? '\u2014'}</Text>
                    </Table.Td>
                    <Table.Td>
                      {entry.status === 'failed' && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          leftSection={<IconRefresh size={14} />}
                          loading={retryMutation.isPending}
                          onClick={e => {
                            e.stopPropagation();
                            handleRetry(entry._id);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                  {expandedId === entry._id && (
                    <Table.Tr key={`${entry._id}-detail`}>
                      <Table.Td colSpan={8}>
                        <Box p="sm">
                          {entry.error && (
                            <Box mb="xs">
                              <Text size="sm" fw={600} c="red">
                                Error:
                              </Text>
                              <Code block>{entry.error}</Code>
                            </Box>
                          )}
                          <Text size="sm" fw={600} mb={4}>
                            Payload:
                          </Text>
                          <Code block>
                            {JSON.stringify(entry.payload, null, 2)}
                          </Code>
                          {entry.response &&
                            Object.keys(entry.response).length > 0 && (
                              <Box mt="xs">
                                <Text size="sm" fw={600} mb={4}>
                                  Response:
                                </Text>
                                <Code block>
                                  {JSON.stringify(entry.response, null, 2)}
                                </Code>
                              </Box>
                            )}
                          {entry.retryOf && (
                            <Text size="sm" c="dimmed" mt="xs">
                              Retry of: {entry.retryOf}
                            </Text>
                          )}
                        </Box>
                      </Table.Td>
                    </Table.Tr>
                  )}
                </Fragment>
              ))}
            </Table.Tbody>
          </Table>
          <Group justify="center">
            <Pagination
              total={totalPages}
              value={page + 1}
              onChange={v => setPage(v - 1)}
            />
          </Group>
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Data Retention Tab
function DataRetentionPanel() {
  const [modalOpen, setModalOpen] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [clickhouseModalOpen, setClickhouseModalOpen] = useState(false);
  const [clickhouseDryRun, setClickhouseDryRun] = useState(false);
  const [clickhouseNuke, setClickhouseNuke] = useState(false);
  const [clickhouseDeleteConfirmation, setClickhouseDeleteConfirmation] =
    useState('');
  const [lastCompletedAction, setLastCompletedAction] = useState<string | null>(
    null,
  );
  const queryClient = useQueryClient();

  const { data: settingsData, isLoading: settingsLoading } =
    useDataRetentionSettings();
  const { data: clickhouseSettingsData, isLoading: clickhouseSettingsLoading } =
    useClickhouseRetentionSettings();
  const { data: clickhouseStatusData, isLoading: clickhouseStatusLoading } =
    useClickhouseRetentionStatus();
  const updateSettings = useUpdateDataRetentionSettings();
  const updateClickhouseSettings = useUpdateClickhouseRetentionSettings();
  const runRetention = useRunDataRetention();
  const runClickhouseRetention = useRunClickhouseRetention();

  const [auditLog, setAuditLog] = useState<number | string>(90);
  const [alertHistory, setAlertHistory] = useState<number | string>(30);
  const [clickhouseThresholdPercent, setClickhouseThresholdPercent] = useState<
    number | string
  >(90);
  const [clickhouseEnabled, setClickhouseEnabled] = useState(true);
  const [settingsInitialized, setSettingsInitialized] = useState(false);
  const [clickhouseSettingsInitialized, setClickhouseSettingsInitialized] =
    useState(false);

  if (settingsData?.data && !settingsInitialized) {
    setAuditLog(settingsData.data.auditLog);
    setAlertHistory(settingsData.data.alertHistory);
    setSettingsInitialized(true);
  }

  if (clickhouseSettingsData?.data && !clickhouseSettingsInitialized) {
    setClickhouseThresholdPercent(
      clickhouseSettingsData.data.targetUsagePercent,
    );
    setClickhouseEnabled(clickhouseSettingsData.data.enabled);
    setClickhouseSettingsInitialized(true);
  }

  const auditLogNum = Number(auditLog);
  const alertHistoryNum = Number(alertHistory);
  const thresholdPercentNum = Number(clickhouseThresholdPercent);
  const auditLogInvalid =
    !Number.isInteger(auditLogNum) || auditLogNum < 1 || auditLogNum > 3650;
  const alertHistoryInvalid =
    !Number.isInteger(alertHistoryNum) ||
    alertHistoryNum < 1 ||
    alertHistoryNum > 3650;
  const clickhouseThresholdInvalid =
    !Number.isInteger(thresholdPercentNum) ||
    thresholdPercentNum < 1 ||
    thresholdPercentNum > 95;

  const clickhouseStatus = clickhouseStatusData?.data;
  const clickhouseUsagePercent = Number(clickhouseStatus?.usagePercent ?? 0);
  const clickhouseTargetUsagePercent =
    clickhouseStatus?.targetUsagePercent ??
    clickhouseSettingsData?.data?.targetUsagePercent ??
    90;
  const clickhouseTableUsageGB =
    clickhouseStatus?.tables.reduce(
      (sum, table) => sum + Number(table.sizeGB),
      0,
    ) ?? 0;
  const clickhouseInactivePartsGB = Number(
    clickhouseStatus?.storageBreakdown?.inactivePartsGB ?? 0,
  );
  const clickhouseDetachedPartsGB = Number(
    clickhouseStatus?.storageBreakdown?.detachedPartsGB ?? 0,
  );
  const clickhouseReclaimableGB =
    clickhouseInactivePartsGB + clickhouseDetachedPartsGB;
  const clickhouseUntrackedUsageGB = Math.max(
    0,
    Number(
      clickhouseStatus?.storageBreakdown?.otherFilesystemGB ??
        Number(clickhouseStatus?.totalSizeGB ?? 0) - clickhouseTableUsageGB,
    ),
  );

  const handleSaveSettings = useCallback(() => {
    if (auditLogInvalid || alertHistoryInvalid) {
      notifications.show({
        color: 'red',
        title: 'Invalid MongoDB settings',
        message: 'Retention must be a whole number between 1 and 3650 days.',
      });
      return;
    }

    updateSettings.mutate(
      { auditLog: auditLogNum, alertHistory: alertHistoryNum },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            title: 'MongoDB settings saved',
            message: 'Document retention settings updated successfully.',
          });
          queryClient.invalidateQueries({
            queryKey: ['admin', 'data-retention-settings'],
          });
        },
        onError: e => {
          notifications.show({
            color: 'red',
            title: 'Save failed',
            message: e.message ?? 'Failed to update retention settings.',
          });
        },
      },
    );
  }, [
    auditLogInvalid,
    alertHistoryInvalid,
    auditLogNum,
    alertHistoryNum,
    updateSettings,
    queryClient,
  ]);

  const handleSaveClickhouseSettings = useCallback(() => {
    if (clickhouseThresholdInvalid) {
      notifications.show({
        color: 'red',
        title: 'Invalid ClickHouse settings',
        message: 'Disk threshold must be a whole number between 1% and 95%.',
      });
      return;
    }

    updateClickhouseSettings.mutate(
      {
        enabled: clickhouseEnabled,
        targetUsagePercent: thresholdPercentNum,
      },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            title: 'ClickHouse settings saved',
            message: 'Disk protection settings updated successfully.',
          });
          queryClient.invalidateQueries({
            queryKey: ['admin', 'clickhouse-retention-settings'],
          });
          queryClient.invalidateQueries({
            queryKey: ['admin', 'clickhouse-retention-status'],
          });
        },
        onError: e => {
          notifications.show({
            color: 'red',
            title: 'Save failed',
            message:
              e.message ?? 'Failed to update ClickHouse retention settings.',
          });
        },
      },
    );
  }, [
    clickhouseThresholdInvalid,
    clickhouseEnabled,
    thresholdPercentNum,
    updateClickhouseSettings,
    queryClient,
  ]);

  const handleRun = useCallback(() => setModalOpen(true), []);
  const handleRunClickhouse = useCallback(
    () => setClickhouseModalOpen(true),
    [],
  );

  const handleConfirm = useCallback(() => {
    setModalOpen(false);
    runRetention.mutate(
      { dryRun },
      {
        onSuccess: () => {
          const action = dryRun
            ? 'MongoDB cleanup preview completed; no data was deleted.'
            : 'Expired MongoDB documents were deleted.';
          setLastCompletedAction(action);
          notifications.show({
            color: 'green',
            title: dryRun ? 'Preview complete' : 'Cleanup complete',
            message: action,
          });
          queryClient.invalidateQueries({ queryKey: ['admin', 'audit-log'] });
        },
        onError: e => {
          notifications.show({
            color: 'red',
            title: 'Cleanup failed',
            message: e.message ?? 'An error occurred during data retention.',
          });
        },
      },
    );
  }, [dryRun, runRetention, queryClient]);

  const handleConfirmClickhouse = useCallback(() => {
    setClickhouseModalOpen(false);
    setClickhouseDeleteConfirmation('');
    runClickhouseRetention.mutate(
      {
        dryRun: clickhouseDryRun,
        nuke: clickhouseNuke,
        force: clickhouseNuke,
      },
      {
        onSuccess: () => {
          const action = clickhouseDryRun
            ? clickhouseNuke
              ? 'Full ClickHouse deletion preview completed; no data was deleted.'
              : 'ClickHouse cleanup preview completed; no data was deleted.'
            : clickhouseNuke
              ? 'All cleanable ClickHouse telemetry was deleted.'
              : 'Oldest ClickHouse partitions were deleted to reduce disk usage.';
          setLastCompletedAction(action);
          notifications.show({
            color: 'green',
            title: clickhouseDryRun
              ? 'Preview complete'
              : clickhouseNuke
                ? 'Telemetry deleted'
                : 'Cleanup complete',
            message: action,
          });
          queryClient.invalidateQueries({
            queryKey: ['admin', 'clickhouse-retention-status'],
          });
        },
        onError: e => {
          notifications.show({
            color: 'red',
            title: 'Cleanup failed',
            message:
              e.message ?? 'An error occurred during ClickHouse retention.',
          });
        },
      },
    );
  }, [clickhouseDryRun, clickhouseNuke, runClickhouseRetention, queryClient]);

  const closeClickhouseModal = useCallback(() => {
    setClickhouseModalOpen(false);
    setClickhouseDeleteConfirmation('');
  }, []);

  return (
    <Stack gap="lg">
      <Box>
        <Title order={3}>Data retention</Title>
        <Text size="sm" c="dimmed">
          Configure automatic retention and run cleanup separately for MongoDB
          documents and ClickHouse telemetry.
        </Text>
      </Box>

      {lastCompletedAction ? (
        <Paper withBorder p="sm" radius="md">
          <Text size="xs" c="dimmed">
            Last completed action
          </Text>
          <Text size="sm" fw={600}>
            {lastCompletedAction}
          </Text>
        </Paper>
      ) : null}

      <Paper withBorder p="md" radius="md">
        <Stack gap="md">
          <Box>
            <Title order={4}>MongoDB document retention</Title>
            <Text size="sm" c="dimmed">
              Scheduled cleanup deletes audit-log and alert-history documents
              after the configured age.
            </Text>
          </Box>

          {settingsLoading ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : (
            <>
              <Group grow align="flex-start">
                <NumberInput
                  label="Keep audit logs for"
                  description="Days before an audit-log document becomes eligible for deletion."
                  suffix=" days"
                  value={auditLog}
                  onChange={setAuditLog}
                  min={1}
                  max={3650}
                  allowDecimal={false}
                  error={
                    auditLogInvalid ? 'Enter 1–3650 whole days.' : undefined
                  }
                  size="sm"
                />
                <NumberInput
                  label="Keep alert history for"
                  description="Days before an alert-history document becomes eligible for deletion."
                  suffix=" days"
                  value={alertHistory}
                  onChange={setAlertHistory}
                  min={1}
                  max={3650}
                  allowDecimal={false}
                  error={
                    alertHistoryInvalid ? 'Enter 1–3650 whole days.' : undefined
                  }
                  size="sm"
                />
              </Group>
              <Button
                onClick={handleSaveSettings}
                loading={updateSettings.isPending}
                disabled={auditLogInvalid || alertHistoryInvalid}
                size="sm"
              >
                Save MongoDB retention
              </Button>
            </>
          )}

          <Box
            pt="sm"
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Text size="sm" fw={600}>
              Manual MongoDB cleanup
            </Text>
            <Text size="xs" c="dimmed" mb="sm">
              Preview the expired-document scope before permanently deleting it.
            </Text>
            <Group>
              <Button
                variant="secondary"
                onClick={() => {
                  setDryRun(true);
                  handleRun();
                }}
                loading={runRetention.isPending && dryRun}
                disabled={runRetention.isPending}
              >
                Preview MongoDB cleanup
              </Button>
              <Button
                leftSection={<IconTrash size={16} />}
                color="red"
                onClick={() => {
                  setDryRun(false);
                  handleRun();
                }}
                loading={runRetention.isPending && !dryRun}
                disabled={runRetention.isPending}
              >
                Delete expired MongoDB documents
              </Button>
            </Group>
          </Box>
        </Stack>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start">
            <Box>
              <Title order={4}>ClickHouse disk protection</Title>
              <Text size="sm" c="dimmed">
                Hourly cleanup drops the oldest telemetry partitions when disk
                usage reaches the configured threshold.
              </Text>
            </Box>
            {clickhouseStatus ? (
              <Badge
                color={clickhouseStatus.isOverThreshold ? 'red' : 'blue'}
                variant="light"
              >
                {clickhouseStatus.isOverThreshold
                  ? 'Cleanup needed'
                  : 'Disk usage stable'}
              </Badge>
            ) : (
              <Badge color="gray" variant="light">
                Status unavailable
              </Badge>
            )}
          </Group>

          {clickhouseSettingsLoading ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : (
            <>
              <Group grow align="flex-end">
                <NumberInput
                  label="Start cleanup when disk usage reaches"
                  description="Cleanup continues until usage is below this threshold."
                  suffix="%"
                  value={clickhouseThresholdPercent}
                  onChange={setClickhouseThresholdPercent}
                  min={1}
                  max={95}
                  allowDecimal={false}
                  error={
                    clickhouseThresholdInvalid
                      ? 'Enter a whole percentage from 1–95.'
                      : undefined
                  }
                  size="sm"
                />
                <Switch
                  label="Run automatic cleanup hourly"
                  description={
                    clickhouseEnabled
                      ? 'Automatic disk protection is enabled.'
                      : 'Automatic cleanup is paused.'
                  }
                  checked={clickhouseEnabled}
                  onChange={event =>
                    setClickhouseEnabled(event.currentTarget.checked)
                  }
                />
              </Group>

              {clickhouseStatusLoading ? (
                <Center py="md">
                  <Loader size="sm" />
                </Center>
              ) : clickhouseStatus ? (
                <Stack gap="xs">
                  <Group justify="space-between">
                    <Text size="sm" fw={600}>
                      Current usage {clickhouseStatus.usagePercent}%
                    </Text>
                    <Text size="xs" c="dimmed">
                      Cleanup threshold {clickhouseTargetUsagePercent}%
                    </Text>
                  </Group>
                  <Progress
                    value={Math.min(clickhouseUsagePercent, 100)}
                    color={
                      clickhouseUsagePercent >= clickhouseTargetUsagePercent
                        ? 'red'
                        : 'blue'
                    }
                  />
                  <Group grow>
                    <Box>
                      <Text size="xs" c="dimmed">
                        Disk size
                      </Text>
                      <Text fw={600}>{clickhouseStatus.diskSizeGB} GB</Text>
                    </Box>
                    <Box>
                      <Text size="xs" c="dimmed">
                        Used
                      </Text>
                      <Text fw={600}>{clickhouseStatus.totalSizeGB} GB</Text>
                    </Box>
                    <Box>
                      <Text size="xs" c="dimmed">
                        Free
                      </Text>
                      <Text fw={600}>{clickhouseStatus.freeDiskGB} GB</Text>
                    </Box>
                    <Box>
                      <Text size="xs" c="dimmed">
                        Reclaimable inactive data
                      </Text>
                      <Text fw={600}>
                        {clickhouseReclaimableGB.toFixed(2)} GB
                      </Text>
                    </Box>
                  </Group>
                  {clickhouseUntrackedUsageGB > 0.01 ? (
                    <Text size="xs" c="dimmed">
                      {clickhouseUntrackedUsageGB.toFixed(2)} GB is other
                      ClickHouse filesystem usage such as metadata, logs,
                      caches, or merge leftovers.
                    </Text>
                  ) : null}
                </Stack>
              ) : (
                <Text size="sm" c="dimmed">
                  Disk usage is unavailable. Status refreshes every minute.
                </Text>
              )}

              <Group>
                <Button
                  onClick={handleSaveClickhouseSettings}
                  loading={updateClickhouseSettings.isPending}
                  disabled={clickhouseThresholdInvalid}
                  size="sm"
                >
                  Save ClickHouse protection
                </Button>
                <Button
                  leftSection={<IconRefresh size={16} />}
                  variant="secondary"
                  onClick={() => {
                    queryClient.invalidateQueries({
                      queryKey: ['admin', 'clickhouse-retention-status'],
                    });
                  }}
                  size="sm"
                >
                  Refresh disk status
                </Button>
              </Group>
            </>
          )}

          <Box
            pt="sm"
            style={{
              borderTop: '1px solid var(--mantine-color-default-border)',
            }}
          >
            <Text size="sm" fw={600}>
              Threshold cleanup
            </Text>
            <Text size="xs" c="dimmed" mb="sm">
              Preview or drop only the oldest partitions needed to return below
              the configured disk threshold.
            </Text>
            <Group>
              <Button
                variant="secondary"
                onClick={() => {
                  setClickhouseDryRun(true);
                  setClickhouseNuke(false);
                  handleRunClickhouse();
                }}
                loading={
                  runClickhouseRetention.isPending &&
                  clickhouseDryRun &&
                  !clickhouseNuke
                }
                disabled={runClickhouseRetention.isPending}
              >
                Preview threshold cleanup
              </Button>
              <Button
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => {
                  setClickhouseDryRun(false);
                  setClickhouseNuke(false);
                  handleRunClickhouse();
                }}
                loading={
                  runClickhouseRetention.isPending &&
                  !clickhouseDryRun &&
                  !clickhouseNuke
                }
                disabled={runClickhouseRetention.isPending}
              >
                Drop oldest ClickHouse partitions
              </Button>
            </Group>
          </Box>
        </Stack>
      </Paper>

      <Paper
        withBorder
        p="md"
        radius="md"
        style={{ borderColor: 'var(--mantine-color-red-7)' }}
      >
        <Stack gap="sm">
          <Box>
            <Title order={4} c="red">
              Delete all ClickHouse telemetry
            </Title>
            <Text size="sm" c="dimmed">
              Permanently removes every cleanable telemetry partition, detached
              part, and ClickHouse system log. This is broader than threshold
              cleanup and cannot be undone.
            </Text>
          </Box>
          <Group>
            <Button
              variant="secondary"
              onClick={() => {
                setClickhouseDeleteConfirmation('');
                setClickhouseDryRun(true);
                setClickhouseNuke(true);
                handleRunClickhouse();
              }}
              loading={
                runClickhouseRetention.isPending &&
                clickhouseDryRun &&
                clickhouseNuke
              }
              disabled={runClickhouseRetention.isPending}
            >
              Preview full deletion
            </Button>
            <Button
              color="red"
              leftSection={<IconTrash size={16} />}
              onClick={() => {
                setClickhouseDeleteConfirmation('');
                setClickhouseDryRun(false);
                setClickhouseNuke(true);
                handleRunClickhouse();
              }}
              loading={
                runClickhouseRetention.isPending &&
                !clickhouseDryRun &&
                clickhouseNuke
              }
              disabled={runClickhouseRetention.isPending}
            >
              Delete all ClickHouse telemetry
            </Button>
          </Group>
        </Stack>
      </Paper>

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={
          dryRun
            ? 'Preview MongoDB cleanup'
            : 'Delete expired MongoDB documents'
        }
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            {dryRun
              ? 'This scans configured MongoDB collections and reports the expired-document scope. No data will be modified.'
              : 'This permanently deletes expired documents from all configured MongoDB collections. This action cannot be undone.'}
          </Text>
          <Group justify="flex-end">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              color={dryRun ? 'blue' : 'red'}
              onClick={handleConfirm}
              loading={runRetention.isPending}
            >
              {dryRun ? 'Run preview' : 'Delete expired documents'}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal
        opened={clickhouseModalOpen}
        onClose={closeClickhouseModal}
        title={
          clickhouseDryRun
            ? clickhouseNuke
              ? 'Preview full ClickHouse deletion'
              : 'Preview ClickHouse threshold cleanup'
            : clickhouseNuke
              ? 'Delete all ClickHouse telemetry'
              : 'Drop oldest ClickHouse partitions'
        }
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            {clickhouseDryRun
              ? clickhouseNuke
                ? 'This scans all cleanable telemetry partitions, detached parts, and system logs. No data will be modified.'
                : 'This scans the oldest partitions needed to return below the disk threshold. No data will be modified.'
              : clickhouseNuke
                ? 'This permanently removes all cleanable telemetry partitions, detached parts, and system logs. This action cannot be undone.'
                : 'This permanently drops the oldest telemetry partitions until disk usage is below the configured threshold. This action cannot be undone.'}
          </Text>
          {clickhouseNuke && !clickhouseDryRun ? (
            <TextInput
              label="Type DELETE CLICKHOUSE DATA to continue"
              value={clickhouseDeleteConfirmation}
              onChange={event =>
                setClickhouseDeleteConfirmation(event.currentTarget.value)
              }
              error={
                clickhouseDeleteConfirmation &&
                clickhouseDeleteConfirmation !== 'DELETE CLICKHOUSE DATA'
                  ? 'Confirmation does not match.'
                  : undefined
              }
              autoFocus
            />
          ) : null}
          <Group justify="flex-end">
            <Button variant="secondary" onClick={closeClickhouseModal}>
              Cancel
            </Button>
            <Button
              color={clickhouseDryRun ? 'blue' : 'red'}
              onClick={handleConfirmClickhouse}
              loading={runClickhouseRetention.isPending}
              disabled={
                clickhouseNuke &&
                !clickhouseDryRun &&
                clickhouseDeleteConfirmation !== 'DELETE CLICKHOUSE DATA'
              }
            >
              {clickhouseDryRun
                ? 'Run preview'
                : clickhouseNuke
                  ? 'Delete all telemetry'
                  : 'Drop oldest partitions'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Proactive Investigations Tab
// ---------------------------------------------------------------------------
const DEFAULT_PI_SETTINGS = {
  enabled: false,
  modelName: 'qwen-plus-latest',
  modelBaseUrl: '',
  maxRunsPerTeamHour: 4,
  reopenAfterHours: 24,
  memoryTTLDays: 30,
  budget: {
    maxToolCalls: 20,
    maxTokens: 50000,
  },
  anomalySweep: {
    errorRateMultiplier: 2,
    minAbsoluteCount: 10,
    topK: 5,
  },
  circuitBreaker: {
    maxFailuresPerHour: 5,
    pauseMinutes: 60,
  },
};

function ProactiveInvestigationsPanel() {
  const queryClient = useQueryClient();
  const { data: settingsData, isLoading: settingsLoading } =
    useProactiveInvestigationSettings();
  const updateSettings = useUpdateProactiveInvestigationSettings();

  const [form, setForm] =
    useState<typeof DEFAULT_PI_SETTINGS>(DEFAULT_PI_SETTINGS);
  const [formInitialized, setFormInitialized] = useState(false);

  if (settingsData?.data && !formInitialized) {
    const s = settingsData.data;
    setForm({
      enabled: s.enabled ?? DEFAULT_PI_SETTINGS.enabled,
      modelName: s.modelName ?? DEFAULT_PI_SETTINGS.modelName,
      modelBaseUrl: s.modelBaseUrl ?? DEFAULT_PI_SETTINGS.modelBaseUrl,
      maxRunsPerTeamHour:
        s.maxRunsPerTeamHour ?? DEFAULT_PI_SETTINGS.maxRunsPerTeamHour,
      reopenAfterHours:
        s.reopenAfterHours ?? DEFAULT_PI_SETTINGS.reopenAfterHours,
      memoryTTLDays: s.memoryTTLDays ?? DEFAULT_PI_SETTINGS.memoryTTLDays,
      budget: {
        maxToolCalls:
          s.budget?.maxToolCalls ?? DEFAULT_PI_SETTINGS.budget.maxToolCalls,
        maxTokens: s.budget?.maxTokens ?? DEFAULT_PI_SETTINGS.budget.maxTokens,
      },
      anomalySweep: {
        errorRateMultiplier:
          s.anomalySweep?.errorRateMultiplier ??
          DEFAULT_PI_SETTINGS.anomalySweep.errorRateMultiplier,
        minAbsoluteCount:
          s.anomalySweep?.minAbsoluteCount ??
          DEFAULT_PI_SETTINGS.anomalySweep.minAbsoluteCount,
        topK: s.anomalySweep?.topK ?? DEFAULT_PI_SETTINGS.anomalySweep.topK,
      },
      circuitBreaker: {
        maxFailuresPerHour:
          s.circuitBreaker?.maxFailuresPerHour ??
          DEFAULT_PI_SETTINGS.circuitBreaker.maxFailuresPerHour,
        pauseMinutes:
          s.circuitBreaker?.pauseMinutes ??
          DEFAULT_PI_SETTINGS.circuitBreaker.pauseMinutes,
      },
    });
    setFormInitialized(true);
  }

  const handleSave = useCallback(() => {
    updateSettings.mutate(form, {
      onSuccess: () => {
        notifications.show({
          color: 'green',
          title: 'Settings Saved',
          message: 'Proactive investigation settings updated successfully.',
        });
        queryClient.invalidateQueries({
          queryKey: ['admin', 'proactive-investigation-settings'],
        });
      },
      onError: e => {
        notifications.show({
          color: 'red',
          title: 'Save Failed',
          message: e.message ?? 'Failed to update settings.',
        });
      },
    });
  }, [form, updateSettings, queryClient]);

  if (settingsLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Title order={4}>General</Title>
        <Switch
          label="Enable proactive investigations"
          checked={form.enabled}
          onChange={e => {
            const enabled = e.currentTarget.checked;
            setForm(f => ({ ...f, enabled }));
          }}
        />
        <Group grow>
          <TextInput
            label="Model name"
            placeholder="e.g. qwen-plus-latest"
            value={form.modelName}
            onChange={e => {
              const modelName = e.currentTarget.value;
              setForm(f => ({ ...f, modelName }));
            }}
          />
          <TextInput
            label="Model base URL (optional)"
            value={form.modelBaseUrl}
            onChange={e => {
              const modelBaseUrl = e.currentTarget.value;
              setForm(f => ({ ...f, modelBaseUrl }));
            }}
          />
        </Group>
        <Text size="sm" c="dimmed">
          API key is configured via environment variable — not editable here.
        </Text>
        <Group grow>
          <NumberInput
            label="Max runs per team per hour"
            min={1}
            value={form.maxRunsPerTeamHour}
            onChange={v =>
              setForm(f => ({ ...f, maxRunsPerTeamHour: Number(v) }))
            }
          />
          <NumberInput
            label="Reopen after hours"
            min={1}
            value={form.reopenAfterHours}
            onChange={v =>
              setForm(f => ({ ...f, reopenAfterHours: Number(v) }))
            }
          />
          <NumberInput
            label="Memory TTL (days)"
            min={1}
            value={form.memoryTTLDays}
            onChange={v => setForm(f => ({ ...f, memoryTTLDays: Number(v) }))}
          />
        </Group>
      </Stack>

      <Stack gap="sm">
        <Title order={4}>Budget</Title>
        <Group grow>
          <NumberInput
            label="Max tool calls"
            min={1}
            value={form.budget.maxToolCalls}
            onChange={v =>
              setForm(f => ({
                ...f,
                budget: { ...f.budget, maxToolCalls: Number(v) },
              }))
            }
          />
          <NumberInput
            label="Max tokens"
            min={1}
            value={form.budget.maxTokens}
            onChange={v =>
              setForm(f => ({
                ...f,
                budget: { ...f.budget, maxTokens: Number(v) },
              }))
            }
          />
        </Group>
      </Stack>

      <Stack gap="sm">
        <Title order={4}>Anomaly Sweep</Title>
        <Group grow>
          <NumberInput
            label="Error rate multiplier"
            step={0.1}
            min={0.1}
            value={form.anomalySweep.errorRateMultiplier}
            onChange={v =>
              setForm(f => ({
                ...f,
                anomalySweep: {
                  ...f.anomalySweep,
                  errorRateMultiplier: Number(v),
                },
              }))
            }
          />
          <NumberInput
            label="Min absolute error count"
            min={1}
            value={form.anomalySweep.minAbsoluteCount}
            onChange={v =>
              setForm(f => ({
                ...f,
                anomalySweep: {
                  ...f.anomalySweep,
                  minAbsoluteCount: Number(v),
                },
              }))
            }
          />
          <NumberInput
            label="Top K services to investigate"
            min={1}
            value={form.anomalySweep.topK}
            onChange={v =>
              setForm(f => ({
                ...f,
                anomalySweep: { ...f.anomalySweep, topK: Number(v) },
              }))
            }
          />
        </Group>
      </Stack>

      <Stack gap="sm">
        <Title order={4}>Circuit Breaker</Title>
        <Group grow>
          <NumberInput
            label="Circuit breaker: max failures per hour"
            min={1}
            value={form.circuitBreaker.maxFailuresPerHour}
            onChange={v =>
              setForm(f => ({
                ...f,
                circuitBreaker: {
                  ...f.circuitBreaker,
                  maxFailuresPerHour: Number(v),
                },
              }))
            }
          />
          <NumberInput
            label="Circuit breaker: pause duration (minutes)"
            min={1}
            value={form.circuitBreaker.pauseMinutes}
            onChange={v =>
              setForm(f => ({
                ...f,
                circuitBreaker: {
                  ...f.circuitBreaker,
                  pauseMinutes: Number(v),
                },
              }))
            }
          />
        </Group>
      </Stack>

      <Group>
        <Button
          onClick={handleSave}
          loading={updateSettings.isPending}
          size="sm"
        >
          Save Settings
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function AdminPage() {
  const brandName = useBrandDisplayName();
  const isSuperAdmin = useIsSuperAdmin();

  if (!isSuperAdmin) {
    return <AccessDenied />;
  }

  return (
    <div data-testid="admin-page">
      <Head>
        <title>Platform Admin - {brandName}</title>
      </Head>
      <Container maw={1200} py="lg" px="lg">
        <Title order={2} mb="lg">
          Platform Admin
        </Title>

        <Tabs defaultValue="teams">
          <Tabs.List mb="lg">
            <Tabs.Tab value="teams">Teams</Tabs.Tab>
            <Tabs.Tab value="roles">Roles</Tabs.Tab>
            <Tabs.Tab value="audit-log">Global Audit Log</Tabs.Tab>
            <Tabs.Tab value="notification-log">Notification Log</Tabs.Tab>
            <Tabs.Tab value="data-retention">Data Retention</Tabs.Tab>
            <Tabs.Tab value="proactive-investigations">
              Proactive Investigations
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="teams">
            <TeamsPanel />
          </Tabs.Panel>

          <Tabs.Panel value="roles">
            <RolesSection />
          </Tabs.Panel>

          <Tabs.Panel value="audit-log">
            <AuditLogPanel />
          </Tabs.Panel>

          <Tabs.Panel value="notification-log">
            <NotificationLogPanel />
          </Tabs.Panel>

          <Tabs.Panel value="data-retention">
            <DataRetentionPanel />
          </Tabs.Panel>

          <Tabs.Panel value="proactive-investigations">
            <ProactiveInvestigationsPanel />
          </Tabs.Panel>
        </Tabs>
      </Container>
    </div>
  );
}

AdminPage.getLayout = withAppNav;
