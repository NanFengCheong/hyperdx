import { Fragment, useCallback, useState } from 'react';
import Head from 'next/head';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Collapse,
  Container,
  Group,
  Loader,
  Modal,
  NumberInput,
  Pagination,
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
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';

import RolesSection from './components/TeamSettings/RolesSection';
import { useIsSuperAdmin } from './hooks/usePermission';
import { useBrandDisplayName } from './theme/ThemeProvider';
import {
  useAdminAuditLog,
  useAdminNotificationLog,
  useAdminNotificationLogRetention,
  useAdminRetryNotification,
  useAdminTeamMembers,
  useAdminTeams,
  useDataRetentionSettings,
  useProactiveInvestigationSettings,
  useRunDataRetention,
  useToggleSuperAdmin,
  useUpdateAdminNotificationLogRetention,
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
  );
}

// ---------------------------------------------------------------------------
// Teams Tab
// ---------------------------------------------------------------------------
function TeamsPanel() {
  const { data, isLoading } = useAdminTeams();
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

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
    <Table highlightOnHover withTableBorder withColumnBorders={false}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th w={40} />
          <Table.Th>Team Name</Table.Th>
          <Table.Th>Created</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {teams.map((team: any) => {
          const isExpanded = expandedTeamId === team._id;
          return (
            <Table.Tr key={team._id} style={{ cursor: 'pointer' }}>
              <Table.Td colSpan={3} p={0}>
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
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td colSpan={3} p={0}>
                        <Collapse in={isExpanded}>
                          {isExpanded && <TeamMembersTable teamId={team._id} />}
                        </Collapse>
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
          value={fromDate}
          onChange={setFromDate}
          clearable
          size="sm"
        />
        <DatePickerInput
          label="To Date"
          placeholder="Select end date"
          value={toDate}
          onChange={setToDate}
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
          value={fromDate}
          onChange={v => {
            setFromDate(v);
            setPage(0);
          }}
          clearable
          size="sm"
        />
        <DatePickerInput
          label="To Date"
          placeholder="Select end date"
          value={toDate}
          onChange={v => {
            setToDate(v);
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
                        <Collapse in={expandedId === entry._id}>
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
                        </Collapse>
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
// ---------------------------------------------------------------------------
function DataRetentionPanel() {
  const [modalOpen, setModalOpen] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const queryClient = useQueryClient();

  const { data: settingsData, isLoading: settingsLoading } =
    useDataRetentionSettings();
  const updateSettings = useUpdateDataRetentionSettings();
  const runRetention = useRunDataRetention();

  const [auditLog, setAuditLog] = useState<number | string>(90);
  const [alertHistory, setAlertHistory] = useState<number | string>(30);
  const [settingsInitialized, setSettingsInitialized] = useState(false);

  // Sync form state when settings load
  if (settingsData?.data && !settingsInitialized) {
    setAuditLog(settingsData.data.auditLog);
    setAlertHistory(settingsData.data.alertHistory);
    setSettingsInitialized(true);
  }

  const handleSaveSettings = useCallback(() => {
    const auditLogNum = Number(auditLog);
    const alertHistoryNum = Number(alertHistory);
    if (
      !auditLogNum ||
      auditLogNum < 1 ||
      !alertHistoryNum ||
      alertHistoryNum < 1
    ) {
      notifications.show({
        color: 'red',
        title: 'Invalid Settings',
        message: 'Retention days must be at least 1.',
      });
      return;
    }
    updateSettings.mutate(
      { auditLog: auditLogNum, alertHistory: alertHistoryNum },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            title: 'Settings Saved',
            message: 'Data retention settings updated successfully.',
          });
          queryClient.invalidateQueries({
            queryKey: ['admin', 'data-retention-settings'],
          });
        },
        onError: e => {
          notifications.show({
            color: 'red',
            title: 'Save Failed',
            message: e.message ?? 'Failed to update retention settings.',
          });
        },
      },
    );
  }, [auditLog, alertHistory, updateSettings, queryClient]);

  const handleRun = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleConfirm = useCallback(() => {
    setModalOpen(false);
    runRetention.mutate(
      { dryRun },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            title: dryRun ? 'Dry Run Complete' : 'Cleanup Complete',
            message: dryRun
              ? 'Data retention dry run finished. No data was deleted.'
              : 'Data retention cleanup completed successfully.',
          });
          queryClient.invalidateQueries({ queryKey: ['admin', 'audit-log'] });
        },
        onError: e => {
          notifications.show({
            color: 'red',
            title: 'Cleanup Failed',
            message: e.message ?? 'An error occurred during data retention.',
          });
        },
      },
    );
  }, [dryRun, runRetention, queryClient]);

  return (
    <Stack gap="lg">
      {/* Retention Settings */}
      <Stack gap="sm">
        <Title order={4}>Retention Settings</Title>
        <Text size="sm" c="dimmed">
          Configure how many days data is retained before cleanup. Changes take
          effect on the next retention run.
        </Text>

        {settingsLoading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : (
          <>
            <Group grow>
              <NumberInput
                label="Audit Log (days)"
                value={auditLog}
                onChange={setAuditLog}
                min={1}
                max={3650}
                size="sm"
              />
              <NumberInput
                label="Alert History (days)"
                value={alertHistory}
                onChange={setAlertHistory}
                min={1}
                max={3650}
                size="sm"
              />
            </Group>
            <Group>
              <Button
                onClick={handleSaveSettings}
                loading={updateSettings.isPending}
                size="sm"
              >
                Save Settings
              </Button>
            </Group>
          </>
        )}
      </Stack>

      {/* Manual Cleanup */}
      <Stack gap="sm">
        <Title order={4}>Manual Cleanup</Title>
        <Text size="sm" c="dimmed">
          Manually trigger the data retention job. This will clean up expired
          data from MongoDB collections based on the configured retention
          settings above.
        </Text>

        <Group>
          <Button
            leftSection={<IconTrash size={16} />}
            variant="secondary"
            onClick={() => {
              setDryRun(true);
              handleRun();
            }}
            loading={runRetention.isPending && dryRun}
          >
            Dry Run
          </Button>
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            color="red"
            onClick={() => {
              setDryRun(false);
              handleRun();
            }}
            loading={runRetention.isPending && !dryRun}
          >
            Run Cleanup
          </Button>
        </Group>
      </Stack>

      <Modal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        title={dryRun ? 'Confirm Dry Run' : 'Confirm Data Cleanup'}
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            {dryRun
              ? 'This will scan and report how many expired documents would be deleted. No data will be modified.'
              : 'This will permanently delete expired documents from all configured collections. This action cannot be undone.'}
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
              {dryRun ? 'Run Dry Run' : 'Confirm Cleanup'}
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
