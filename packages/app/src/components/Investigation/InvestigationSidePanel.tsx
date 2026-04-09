import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { ActionIcon, Box, Drawer, Group, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';

import { useCreateInvestigation } from '../../hooks/useInvestigations';

import InvestigationChat from './InvestigationChat';

interface InvestigationSidePanelProps {
  opened: boolean;
  onClose: () => void;
  traceId?: string;
  alertId?: string;
  sourceId: string;
}

export default function InvestigationSidePanel({
  opened,
  onClose,
  traceId,
  alertId,
  sourceId,
}: InvestigationSidePanelProps) {
  const router = useRouter();
  const createInvestigation = useCreateInvestigation();
  const [investigationId, setInvestigationId] = useState<string | null>(null);

  useHotkeys([['Escape', onClose]]);

  // Create investigation on first open if none exists
  const handleOpen = useCallback(async () => {
    if (investigationId) return;

    const entryPoint = traceId
      ? ({ type: 'trace' as const, traceId } as const)
      : alertId
        ? ({ type: 'alert' as const, alertId } as const)
        : ({ type: 'standalone' as const } as const);

    const result = await createInvestigation.mutateAsync({
      title: traceId
        ? `Investigate trace ${traceId.slice(0, 8)}...`
        : alertId
          ? 'Alert investigation'
          : 'New investigation',
      entryPoint,
      sourceId,
    });

    setInvestigationId(result._id);
  }, [investigationId, traceId, alertId, sourceId, createInvestigation]);

  // Create investigation when panel opens
  useEffect(() => {
    if (opened && !investigationId && !createInvestigation.isPending) {
      handleOpen();
    }
  }, [opened, investigationId, createInvestigation.isPending, handleOpen]);

  // Reset investigationId when panel closes or traceId changes
  useEffect(() => {
    if (!opened) {
      setInvestigationId(null);
    }
  }, [opened]);

  const handleExpand = useCallback(() => {
    if (investigationId) {
      router.push(`/investigations/${investigationId}`);
    }
  }, [investigationId, router]);

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        <Group gap="sm">
          <Text fw={600}>AI Investigation</Text>
          <ActionIcon variant="subtle" size="sm" onClick={handleExpand}>
            {'\u2197'}
          </ActionIcon>
        </Group>
      }
      styles={{
        body: { height: 'calc(100vh - 60px)', padding: 0 },
      }}
    >
      {investigationId ? (
        <InvestigationChat
          investigationId={investigationId}
          sourceId={sourceId}
        />
      ) : (
        <Box p="md">
          <Text c="dimmed">Creating investigation...</Text>
        </Box>
      )}
    </Drawer>
  );
}
