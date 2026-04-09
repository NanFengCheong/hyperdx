import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import {
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Table,
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
};

function InvestigationsContent() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const { data, isLoading } = useInvestigations(page);
  const createInvestigation = useCreateInvestigation();

  const handleNew = async () => {
    const result = await createInvestigation.mutateAsync({
      title: 'New investigation',
      entryPoint: { type: 'standalone' },
    });
    router.push(`/investigations/${result._id}`);
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

      {isLoading ? (
        <Text c="dimmed">Loading...</Text>
      ) : (
        <Paper withBorder>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Title</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Entry Point</Table.Th>
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
                    <Text fw={500}>{inv.title}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={STATUS_COLORS[inv.status] ?? 'gray'}>
                      {inv.status}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="outline" size="sm">
                      {inv.entryPoint.type}
                    </Badge>
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
      )}

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
