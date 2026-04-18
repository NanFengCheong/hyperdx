import { Fragment, useState } from 'react';
import {
  Box,
  Button,
  Card,
  Code,
  Collapse,
  Divider,
  Group,
  Select,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconSearch,
} from '@tabler/icons-react';

import api from '@/api';

const PAGE_SIZE = 50;

const TARGET_TYPE_OPTIONS = [
  { value: 'user', label: 'User' },
  { value: 'role', label: 'Role' },
  { value: 'group', label: 'Group' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'apikey', label: 'API Key' },
  { value: 'connection', label: 'Connection' },
  { value: 'source', label: 'Source' },
  { value: 'policy', label: 'Policy' },
  { value: 'integration', label: 'Integration' },
  { value: 'telegram', label: 'Telegram' },
];

export default function AuditLogSection() {
  const [page, setPage] = useState(0);
  const [actorEmail, setActorEmail] = useState('');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [targetId, setTargetId] = useState('');
  const [search, setSearch] = useState('');
  const [fromDate, setFromDate] = useState<Date | null>(null);
  const [toDate, setToDate] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = {
    actorEmail: actorEmail || undefined,
    action: action || undefined,
    targetType: targetType || undefined,
    targetId: targetId || undefined,
    fromDate: fromDate?.toISOString(),
    toDate: toDate?.toISOString(),
    search: search || undefined,
  };

  const { data: auditLog, isLoading } = api.useTeamAuditLog(
    page,
    PAGE_SIZE,
    filters,
  );
  const { data: actionsData } = api.useTeamAuditLogActions();

  const actionOptions =
    actionsData?.data?.map(a => ({ value: a, label: a })) ?? [];

  const totalCount = auditLog?.totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

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

  const resetFilters = () => {
    setActorEmail('');
    setAction('');
    setTargetType('');
    setTargetId('');
    setSearch('');
    setFromDate(null);
    setToDate(null);
    setPage(0);
  };

  return (
    <Box id="audit-log" data-testid="audit-log-section">
      <Text size="md">Audit Log</Text>
      <Divider my="md" />

      <Group mb="md" gap="sm" wrap="wrap">
        <Select
          size="xs"
          placeholder="Action"
          data={actionOptions}
          value={action}
          onChange={v => {
            setAction(v ?? '');
            setPage(0);
          }}
          clearable
          searchable
          w={200}
        />
        <Select
          size="xs"
          placeholder="Target type"
          data={TARGET_TYPE_OPTIONS}
          value={targetType}
          onChange={v => {
            setTargetType(v ?? '');
            setPage(0);
          }}
          clearable
          w={160}
        />
        <TextInput
          size="xs"
          placeholder="Actor email"
          value={actorEmail}
          onChange={e => {
            setActorEmail(e.currentTarget.value);
            setPage(0);
          }}
          w={200}
        />
        <TextInput
          size="xs"
          placeholder="Target ID"
          value={targetId}
          onChange={e => {
            setTargetId(e.currentTarget.value);
            setPage(0);
          }}
          w={180}
        />
        <TextInput
          size="xs"
          placeholder="Search actor/action/target"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={e => {
            setSearch(e.currentTarget.value);
            setPage(0);
          }}
          w={240}
        />
        <DatePickerInput
          size="xs"
          placeholder="From date"
          value={fromDate}
          onChange={v => {
            setFromDate(v);
            setPage(0);
          }}
          clearable
          w={150}
        />
        <DatePickerInput
          size="xs"
          placeholder="To date"
          value={toDate}
          onChange={v => {
            setToDate(v);
            setPage(0);
          }}
          clearable
          w={150}
        />
        <Button size="compact-xs" variant="subtle" onClick={resetFilters}>
          Reset
        </Button>
      </Group>

      <Card>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={30} />
                <Table.Th>Date</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Target ID</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!isLoading &&
                Array.isArray(auditLog?.data) &&
                auditLog.data.map((entry: any) => (
                  <Fragment key={entry._id}>
                    <Table.Tr
                      onClick={() =>
                        setExpandedId(
                          expandedId === entry._id ? null : entry._id,
                        )
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
                        <Text size="xs">{formatDate(entry.createdAt)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{entry.actorEmail ?? '\u2014'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" fw={500}>
                          {entry.action ?? '\u2014'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{entry.targetType ?? '\u2014'}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" truncate maw={220}>
                          {entry.targetId ?? '\u2014'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                    {expandedId === entry._id && (
                      <Table.Tr key={`${entry._id}-detail`}>
                        <Table.Td colSpan={6}>
                          <Collapse in={expandedId === entry._id}>
                            <Box p="sm">
                              <Text size="xs" fw={600} mb={4}>
                                Details:
                              </Text>
                              <Code block>
                                {JSON.stringify(entry.details ?? {}, null, 2)}
                              </Code>
                              <Text size="xs" c="dimmed" mt="xs">
                                Entry ID: {entry._id}
                              </Text>
                              {entry.actorId && (
                                <Text size="xs" c="dimmed">
                                  Actor ID: {entry.actorId}
                                </Text>
                              )}
                            </Box>
                          </Collapse>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                ))}
              {!isLoading &&
                (!auditLog?.data || auditLog.data.length === 0) && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No audit log entries found.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
            </Table.Tbody>
          </Table>
        </Card.Section>
        {totalCount > PAGE_SIZE && (
          <Card.Section withBorder py="sm" px="lg">
            <Group justify="space-between" align="center">
              <Text size="xs" c="dimmed">
                Page {page + 1} of {totalPages} ({totalCount} entries)
              </Text>
              <Group gap="xs">
                <Button
                  size="compact-sm"
                  variant="secondary"
                  leftSection={<IconChevronLeft size={14} />}
                  disabled={page === 0}
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="compact-sm"
                  variant="secondary"
                  rightSection={<IconChevronRight size={14} />}
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next
                </Button>
              </Group>
            </Group>
          </Card.Section>
        )}
      </Card>
    </Box>
  );
}
