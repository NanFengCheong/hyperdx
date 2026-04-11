import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import {
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Stack,
  Text,
  Title,
} from '@mantine/core';

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

      {/* AI Investigation Report */}
      {investigation.entryPoint.type === 'proactive' &&
        investigation.memory && (
          <Box
            p="md"
            style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}
          >
            <Title order={5} mb="sm">
              AI Investigation Report
            </Title>
            <Stack gap="xs">
              <Text size="sm">{investigation.memory.summary}</Text>

              <Group gap="xs">
                <Text size="xs" c="dimmed">
                  Confidence:
                </Text>
                <Badge
                  size="xs"
                  color={
                    investigation.memory.confidence === 'high'
                      ? 'green'
                      : investigation.memory.confidence === 'medium'
                        ? 'yellow'
                        : 'red'
                  }
                >
                  {investigation.memory.confidence}
                </Badge>
              </Group>

              {investigation.memory.rootCause && (
                <Group gap="xs" align="flex-start">
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    Root cause:
                  </Text>
                  <Text size="xs">{investigation.memory.rootCause}</Text>
                </Group>
              )}

              {investigation.memory.findings.length > 0 && (
                <Group gap="xs">
                  <Text size="xs" c="dimmed">
                    Affected services:
                  </Text>
                  {[
                    ...new Set(
                      investigation.memory.findings.map(f => f.service),
                    ),
                  ].map(svc => (
                    <Badge key={svc} size="xs" variant="outline">
                      {svc}
                    </Badge>
                  ))}
                </Group>
              )}

              {investigation.memory.artifactsCreated.length > 0 && (
                <Group gap="xs">
                  <Text size="xs" c="dimmed">
                    Artifacts:
                  </Text>
                  {investigation.memory.artifactsCreated.map((a, i) => (
                    <Badge
                      key={i}
                      size="xs"
                      variant="light"
                      style={{ cursor: 'pointer' }}
                    >
                      {a.type === 'savedSearch'
                        ? 'Saved Search'
                        : a.type === 'dashboard'
                          ? 'Dashboard'
                          : 'Alert'}
                      : {a.purpose}
                    </Badge>
                  ))}
                </Group>
              )}
            </Stack>
          </Box>
        )}

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
