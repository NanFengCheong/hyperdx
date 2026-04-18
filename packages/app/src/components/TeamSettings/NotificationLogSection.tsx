import { Fragment, useState } from 'react';
import {
  Badge,
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
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react';

import api from '@/api';

const PAGE_SIZE = 50;

const STATUS_COLORS: Record<string, string> = {
  pending: 'yellow',
  success: 'green',
  failed: 'red',
};

const CHANNEL_OPTIONS = [
  { value: '', label: 'All Channels' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'success', label: 'Success' },
  { value: 'failed', label: 'Failed' },
];

export default function NotificationLogSection() {
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

  const { data: notifLog, isLoading } = api.useTeamNotificationLog(
    page,
    PAGE_SIZE,
    filters,
  );
  const retryMutation = api.useRetryNotification();

  const totalCount = notifLog?.totalCount ?? 0;
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

  return (
    <Box id="notification-log" data-testid="notification-log-section">
      <Text size="md">Notification Log</Text>
      <Divider my="md" />

      {/* Filters */}
      <Group mb="md" gap="sm" wrap="wrap">
        <Select
          size="xs"
          placeholder="Channel"
          data={CHANNEL_OPTIONS}
          value={channel}
          onChange={v => {
            setChannel(v ?? '');
            setPage(0);
          }}
          clearable
          w={140}
        />
        <Select
          size="xs"
          placeholder="Status"
          data={STATUS_OPTIONS}
          value={status}
          onChange={v => {
            setStatus(v ?? '');
            setPage(0);
          }}
          clearable
          w={140}
        />
        <TextInput
          size="xs"
          placeholder="Recipient"
          value={recipient}
          onChange={e => {
            setRecipient(e.currentTarget.value);
            setPage(0);
          }}
          w={200}
        />
        <TextInput
          size="xs"
          placeholder="Search subject/recipient"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={e => {
            setSearch(e.currentTarget.value);
            setPage(0);
          }}
          w={220}
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
                <Table.Th>Channel</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Recipient</Table.Th>
                <Table.Th>Subject</Table.Th>
                <Table.Th>Trigger</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!isLoading &&
                Array.isArray(notifLog?.data) &&
                notifLog.data.map((entry: any) => (
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
                        <Badge size="xs" variant="light">
                          {entry.channel}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          size="xs"
                          color={STATUS_COLORS[entry.status] ?? 'gray'}
                        >
                          {entry.status}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" truncate maw={200}>
                          {entry.recipient}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" truncate maw={200}>
                          {entry.subject ?? '\u2014'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs">{entry.trigger?.name ?? '\u2014'}</Text>
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
                                  <Text size="xs" fw={600} c="red">
                                    Error:
                                  </Text>
                                  <Code block>{entry.error}</Code>
                                </Box>
                              )}
                              <Text size="xs" fw={600} mb={4}>
                                Payload:
                              </Text>
                              {typeof entry.payload?.html === 'string' && (
                                <Box mb="xs">
                                  <Text size="xs" c="dimmed" mb={4}>
                                    HTML Preview:
                                  </Text>
                                  <Box
                                    style={{
                                      border: '1px solid var(--mantine-color-dark-4)',
                                      borderRadius: 4,
                                      background: '#fff',
                                    }}
                                  >
                                    <iframe
                                      srcDoc={entry.payload.html}
                                      sandbox=""
                                      title="Notification HTML preview"
                                      style={{
                                        width: '100%',
                                        height: 400,
                                        border: 0,
                                        display: 'block',
                                      }}
                                    />
                                  </Box>
                                </Box>
                              )}
                              <Code block>
                                {JSON.stringify(entry.payload, null, 2)}
                              </Code>
                              {entry.response &&
                                Object.keys(entry.response).length > 0 && (
                                  <Box mt="xs">
                                    <Text size="xs" fw={600} mb={4}>
                                      Response:
                                    </Text>
                                    <Code block>
                                      {JSON.stringify(entry.response, null, 2)}
                                    </Code>
                                  </Box>
                                )}
                              {entry.retryOf && (
                                <Text size="xs" c="dimmed" mt="xs">
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
              {!isLoading &&
                (!notifLog?.data || notifLog.data.length === 0) && (
                  <Table.Tr>
                    <Table.Td colSpan={8}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No notification log entries found.
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
