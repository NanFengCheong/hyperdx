import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Badge, Box, Button, Group, Menu, Text, Title } from '@mantine/core';

import {
  InvestigationChat,
  InvestigationExport,
} from '@/components/Investigation';
import {
  useDeleteInvestigation,
  useExportInvestigation,
  useInvestigation,
  useUpdateInvestigation,
} from '@/hooks/useInvestigations';
import { withAppNav } from '@/layout';

function InvestigationDetailContent() {
  const router = useRouter();
  const id = router.query.id as string;
  const { data: investigation, isLoading, refetch } = useInvestigation(id);
  const updateInvestigation = useUpdateInvestigation();
  const deleteInvestigation = useDeleteInvestigation();
  const exportInvestigation = useExportInvestigation();
  const [exportModalOpened, setExportModalOpened] = useState(false);

  const handleExport = (format: 'markdown' | 'json') => {
    exportInvestigation.mutate(
      { id, format, sourceId: '' },
      {
        onSuccess: () => {
          refetch();
        },
      },
    );
  };

  if (isLoading || !investigation) {
    return (
      <Box p="lg">
        <Text c="dimmed">Loading...</Text>
      </Box>
    );
  }

  // TODO: sourceId should come from investigation metadata or user selection
  const sourceId = '';

  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Box
        p="md"
        style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
      >
        <Group justify="space-between">
          <Group gap="sm">
            <Title order={4}>{investigation.title}</Title>
            <Badge>{investigation.status}</Badge>
            <Badge variant="outline" size="sm">
              {investigation.entryPoint.type}
            </Badge>
          </Group>
          <Group gap="xs">
            <Menu>
              <Menu.Target>
                <Button variant="secondary" size="sm">
                  Actions
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={() =>
                    updateInvestigation.mutate({
                      id: investigation._id,
                      status: 'resolved',
                    })
                  }
                >
                  Mark Resolved
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setExportModalOpened(true);
                    handleExport('markdown');
                  }}
                >
                  Export as Markdown
                </Menu.Item>
                <Menu.Item
                  onClick={() => {
                    setExportModalOpened(true);
                    handleExport('json');
                  }}
                >
                  Export as JSON
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  onClick={async () => {
                    await deleteInvestigation.mutateAsync(investigation._id);
                    router.push('/investigations');
                  }}
                >
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </Box>

      {/* Chat area */}
      <Box style={{ flex: 1, overflow: 'hidden' }}>
        <InvestigationChat investigationId={id} sourceId={sourceId} />
      </Box>

      <InvestigationExport
        opened={exportModalOpened}
        onClose={() => setExportModalOpened(false)}
        exports={investigation.exports ?? []}
        onExport={handleExport}
        isExporting={exportInvestigation.isPending}
      />
    </Box>
  );
}

export default function InvestigationDetailPage() {
  const router = useRouter();
  const id = router.query.id as string;

  return (
    <Box>
      <Head>
        <title>
          {typeof router.query.id === 'string'
            ? `${router.query.id} | HyperDX`
            : 'Investigation | HyperDX'}
        </title>
      </Head>
      <InvestigationDetailContent />
    </Box>
  );
}

InvestigationDetailPage.getLayout = withAppNav;
