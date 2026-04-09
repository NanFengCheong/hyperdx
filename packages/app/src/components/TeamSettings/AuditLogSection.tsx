import { useState } from 'react';
import { Box, Button, Card, Divider, Group, Table, Text } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

import api from '@/api';

const PAGE_SIZE = 50;

export default function AuditLogSection() {
  const [page, setPage] = useState(0);
  const { data: auditLog, isLoading } = api.useTeamAuditLog(page, PAGE_SIZE);

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

  const formatDetails = (details: any) => {
    if (!details) return '\u2014';
    try {
      const str =
        typeof details === 'string' ? details : JSON.stringify(details);
      return str.length > 80 ? str.slice(0, 80) + '\u2026' : str;
    } catch {
      return '\u2014';
    }
  };

  return (
    <Box id="audit-log" data-testid="audit-log-section">
      <Text size="md">Audit Log</Text>
      <Divider my="md" />
      <Card>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Date</Table.Th>
                <Table.Th>Actor</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Details</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!isLoading &&
                Array.isArray(auditLog?.data) &&
                auditLog.data.map((entry: any, idx: number) => (
                  <Table.Tr key={entry._id ?? idx}>
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
                      <Text
                        size="xs"
                        c="dimmed"
                        style={{ maxWidth: 300 }}
                        truncate
                      >
                        {formatDetails(entry.details)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              {!isLoading &&
                (!auditLog?.data || auditLog.data.length === 0) && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
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
