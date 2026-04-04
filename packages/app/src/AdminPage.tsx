import { useCallback, useState } from 'react';
import Head from 'next/head';
import {
  ActionIcon,
  Badge,
  Center,
  Collapse,
  Container,
  Group,
  Loader,
  Pagination,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import {
  IconChevronDown,
  IconChevronRight,
  IconShieldLock,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';

import {
  useAdminAuditLog,
  useAdminTeamMembers,
  useAdminTeams,
  useToggleSuperAdmin,
} from './api';
import RolesSection from './components/TeamSettings/RolesSection';
import { useIsSuperAdmin } from './hooks/usePermission';
import { withAppNav } from './layout';
import { useBrandDisplayName } from './theme/ThemeProvider';

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
                          {isExpanded && (
                            <TeamMembersTable teamId={team._id} />
                          )}
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
        ['from', 'to', 'fromEmail', 'toEmail', 'fromName', 'toName'].includes(
          k,
        )
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
  const { data, isLoading } = useAdminAuditLog(page, AUDIT_PAGE_SIZE);

  const logs = data?.data ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / AUDIT_PAGE_SIZE));

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
                <Text size="sm">
                  {formatAuditDescription(log)}
                </Text>
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
        </Tabs>
      </Container>
    </div>
  );
}

AdminPage.getLayout = withAppNav;
