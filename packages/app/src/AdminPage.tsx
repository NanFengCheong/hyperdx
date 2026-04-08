import { useCallback, useState } from 'react';
import Head from 'next/head';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Collapse,
  Container,
  Group,
  Loader,
  Modal,
  NumberInput,
  Pagination,
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
  IconPlayerPlay,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';

import RolesSection from './components/TeamSettings/RolesSection';
import { useIsSuperAdmin } from './hooks/usePermission';
import { useBrandDisplayName } from './theme/ThemeProvider';
import {
  useAdminAuditLog,
  useAdminTeamMembers,
  useAdminTeams,
  useDataRetentionSettings,
  useRunDataRetention,
  useToggleSuperAdmin,
  useUpdateDataRetentionSettings,
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
            <Tabs.Tab value="data-retention">Data Retention</Tabs.Tab>
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

          <Tabs.Panel value="data-retention">
            <DataRetentionPanel />
          </Tabs.Panel>
        </Tabs>
      </Container>
    </div>
  );
}

AdminPage.getLayout = withAppNav;
