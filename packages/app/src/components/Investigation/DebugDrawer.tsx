import {
  Badge,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Stepper,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconX } from '@tabler/icons-react';

import type { LoopPhase, PhaseGroup } from '../../hooks/useInvestigationStream';

const PHASE_LABELS: Record<LoopPhase, string> = {
  plan: 'Plan',
  execute: 'Execute',
  verify: 'Verify',
  summarize: 'Summarize',
};

const PHASE_DESCRIPTIONS: Record<LoopPhase, string> = {
  plan: 'Build investigation strategy and hypotheses',
  execute: 'Gather evidence by calling data tools',
  verify: 'Challenge findings with independent data',
  summarize: 'Synthesize results and create monitoring artifacts',
};

const ALL_PHASES: LoopPhase[] = ['plan', 'execute', 'verify', 'summarize'];

function PhaseTimeline({
  phaseGroups,
  currentPhase,
  isComplete,
}: {
  phaseGroups: PhaseGroup[];
  currentPhase: LoopPhase | null;
  isComplete: boolean;
}) {
  const completedCount = phaseGroups.filter(
    pg => pg.status === 'completed',
  ).length;
  const stepperActive = isComplete ? ALL_PHASES.length : completedCount;

  return (
    <Stepper
      active={stepperActive}
      orientation="vertical"
      size="sm"
      styles={{
        stepBody: { marginBottom: 8 },
        stepDescription: { marginTop: 4 },
      }}
    >
      {phaseGroups.map(pg => (
        <Stepper.Step
          key={pg.phase}
          label={
            <Group gap="xs">
              <Text fw={500}>{PHASE_LABELS[pg.phase]}</Text>
              {pg.status === 'active' && <Loader size="xs" />}
              {pg.status === 'completed' &&
                pg.toolCallCount !== undefined && (
                  <Badge size="xs" variant="light" color="blue">
                    {pg.toolCallCount} tool
                    {pg.toolCallCount !== 1 ? 's' : ''}
                  </Badge>
                )}
            </Group>
          }
          description={
            <Text size="xs" c="dimmed">
              {pg.status === 'completed' && pg.summaryText
                ? pg.summaryText
                : PHASE_DESCRIPTIONS[pg.phase]}
            </Text>
          }
        />
      ))}
    </Stepper>
  );
}

interface DebugDrawerProps {
  opened: boolean;
  onClose: () => void;
  investigationId: string;
  phaseGroups: PhaseGroup[];
  currentPhase: LoopPhase | null;
  isComplete: boolean;
  confidence?: 'high' | 'medium' | 'low';
  error?: string;
  connected: boolean;
}

export function DebugDrawer({
  opened,
  onClose,
  investigationId,
  phaseGroups,
  currentPhase,
  isComplete,
  confidence,
  error,
  connected,
}: DebugDrawerProps) {
  const confidenceColor =
    confidence === 'high'
      ? 'green'
      : confidence === 'medium'
        ? 'yellow'
        : 'red';

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <Text fw={600}>Investigation Debug</Text>
          {!connected && !isComplete && (
            <Badge size="xs" color="gray">
              Connecting...
            </Badge>
          )}
          {connected && !isComplete && (
            <Badge size="xs" color="blue">
              Live
            </Badge>
          )}
          {isComplete && !error && (
            <Badge size="xs" color={confidenceColor}>
              {confidence ?? 'complete'}
            </Badge>
          )}
          {error && (
            <Badge size="xs" color="red">
              Failed
            </Badge>
          )}
        </Group>
      }
      position="right"
      size={480}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <Stack gap="md" p="xs">
        {error ? (
          <Stack gap="xs" align="center" py="xl">
            <ThemeIcon color="red" size="lg" radius="xl">
              <IconX size={16} />
            </ThemeIcon>
            <Text size="sm" c="red">
              {error}
            </Text>
          </Stack>
        ) : (
          <PhaseTimeline
            phaseGroups={phaseGroups}
            currentPhase={currentPhase}
            isComplete={isComplete}
          />
        )}
      </Stack>
    </Drawer>
  );
}
