import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Paper,
  Table,
  Tabs,
  Text,
  Title,
} from '@mantine/core';

import {
  type Investigation,
  useCreateInvestigation,
  useInvestigations,
} from '@/hooks/useInvestigations';
import { withAppNav } from '@/layout';

const STATUS_COLORS: Record<string, string> = {
  active: 'blue',
  resolved: 'green',
  exported: 'violet',
  pending: 'gray',
  failed: 'red',
  needs_review: 'orange',
  ignored: 'dark',
};

function InvestigationsTable({
  data,
  isLoading,
}: {
  data: { data: Investigation[]; total: number } | undefined;
  isLoading: boolean;
}) {
  const router = useRouter();

  if (isLoading) {
    return <Text c="dimmed">Loading...</Text>;
  }

  return (
    <Paper withBorder>
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Title</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Entry Point</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Created</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data?.data.map((inv: Investigation) => (
            <Table.Tr
              key={inv._id}
              style={{ cursor: 'pointer' }}
              onClick={() => router.push(`/investigations/${inv._id}`)}
            >
              <Table.Td>
                <Group gap="xs">
                  <Text fw={500}>{inv.title}</Text>
                  {inv.entryPoint.type === 'proactive' &&
                    inv.recurrenceCount != null &&
                    inv.recurrenceCount > 0 && (
                      <Badge color="orange" size="xs">
                        ×{inv.recurrenceCount}
                      </Badge>
                    )}
                  {inv.entryPoint.type === 'proactive' && inv.fingerprint && (
                    <Code title="Fingerprint">
                      {inv.fingerprint.slice(0, 8)}
                    </Code>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                <Badge color={STATUS_COLORS[inv.status] ?? 'gray'}>
                  {inv.status}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Badge variant="outline" size="sm">
                    {inv.entryPoint.type}
                  </Badge>
                  {inv.entryPoint.type === 'proactive' && inv.source && (
                    <Badge size="sm" color="teal" variant="light">
                      {inv.source}
                    </Badge>
                  )}
                </Group>
              </Table.Td>
              <Table.Td>
                {inv.entryPoint.type === 'proactive' && inv.source ? (
                  <Text size="sm">{inv.source}</Text>
                ) : (
                  <Text size="sm" c="dimmed">
                    —
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {new Date(inv.createdAt).toLocaleDateString()}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Paper>
  );
}

function InvestigationsContent() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState('all');
  const createInvestigation = useCreateInvestigation();

  const source = activeTab === 'auto' ? 'proactive' : undefined;
  const { data, isLoading } = useInvestigations(page, 20, source);

  const handleNew = async () => {
    const result = await createInvestigation.mutateAsync({
      title: 'New investigation',
      entryPoint: { type: 'standalone' },
    });
    router.push(`/investigations/${result._id}`);
  };

  const handleTabChange = (value: string | null) => {
    setActiveTab(value ?? 'all');
    setPage(1);
  };

  return (
    <Box p="lg">
      <Group justify="space-between" mb="lg">
        <Title order={3}>Investigations</Title>
        <Button
          variant="primary"
          onClick={handleNew}
          loading={createInvestigation.isPending}
        >
          New Investigation
        </Button>
      </Group>

      <Tabs value={activeTab} onChange={handleTabChange} mb="md">
        <Tabs.List>
          <Tabs.Tab value="all">All</Tabs.Tab>
          <Tabs.Tab value="auto">Auto investigations</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <InvestigationsTable data={data} isLoading={isLoading} />

      {data && data.total > 20 && (
        <Group justify="center" mt="md">
          <Button
            variant="subtle"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            Previous
          </Button>
          <Text size="sm">
            Page {page} of {Math.ceil(data.total / 20)}
          </Text>
          <Button
            variant="subtle"
            disabled={page * 20 >= data.total}
            onClick={() => setPage(p => p + 1)}
          >
            Next
          </Button>
        </Group>
      )}
    </Box>
  );
}

export default function InvestigationsPage() {
  return (
    <Box>
      <Head>
        <title>Investigations | HyperDX</title>
      </Head>
      <InvestigationsContent />
    </Box>
  );
}

InvestigationsPage.getLayout = withAppNav;
