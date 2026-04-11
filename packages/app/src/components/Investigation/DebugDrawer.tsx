import {
  Accordion,
  Badge,
  Drawer,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';

import type {
  BudgetSnapshot,
  LoopPhase,
  PhaseGroup,
  ToolCallEntry,
} from '../../hooks/useInvestigationStream';
import { BudgetBar } from './BudgetBar';
import { ToolCallCard } from './ToolCallCard';

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

function PhaseTimeline({
  phaseGroups,
  currentPhase,
  isComplete,
  toolCallsByPhase,
  budgetSnapshot,
}: {
  phaseGroups: PhaseGroup[];
  currentPhase: LoopPhase | null;
  isComplete: boolean;
  toolCallsByPhase: Record<string, ToolCallEntry[]>;
  budgetSnapshot?: BudgetSnapshot;
}) {
  const activePhase = isComplete ? null : currentPhase;
  const startedAt = phaseGroups.find(pg => pg.phase === currentPhase)?.startedAt;

  return (
    <Stack gap="xs">
      <BudgetBar
        budgetSnapshot={budgetSnapshot}
        isActive={!isComplete}
        startedAt={startedAt}
      />
      <Accordion
        value={activePhase}
        multiple={false}
        chevronPosition="right"
        styles={{ item: { borderBottom: '1px solid var(--mantine-color-dark-5)' } }}
      >
        {phaseGroups.map(pg => {
          const calls = toolCallsByPhase[pg.phase] ?? [];
          return (
            <Accordion.Item key={pg.phase} value={pg.phase}>
              <Accordion.Control>
                <Group gap="xs">
                  {pg.status === 'completed' ? (
                    <ThemeIcon size="xs" color="green" radius="xl" variant="light">
                      <IconCheck size={10} />
                    </ThemeIcon>
                  ) : pg.status === 'active' ? (
                    <Loader size="xs" />
                  ) : null}
                  <Text size="sm" fw={500}>
                    {PHASE_LABELS[pg.phase]}
                  </Text>
                  {calls.length > 0 && (
                    <Badge size="xs" variant="light" color="blue">
                      {calls.length} tool{calls.length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </Group>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack gap={6}>
                  {calls.length === 0 ? (
                    <Text size="xs" c="dimmed">
                      {pg.status === 'pending'
                        ? PHASE_DESCRIPTIONS[pg.phase]
                        : pg.summaryText ?? PHASE_DESCRIPTIONS[pg.phase]}
                    </Text>
                  ) : (
                    <>
                      {pg.summaryText && (
                        <Text size="xs" c="dimmed" mb={4}>
                          {pg.summaryText}
                        </Text>
                      )}
                      {calls.map(entry => (
                        <ToolCallCard key={entry.callIndex} entry={entry} />
                      ))}
                    </>
                  )}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          );
        })}
      </Accordion>
    </Stack>
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
  toolCallsByPhase: Record<string, ToolCallEntry[]>;
  budgetSnapshot?: BudgetSnapshot;
}

export function DebugDrawer({
  opened,
  onClose,
  investigationId: _investigationId,
  phaseGroups,
  currentPhase,
  isComplete,
  confidence,
  error,
  connected,
  toolCallsByPhase,
  budgetSnapshot,
}: DebugDrawerProps) {
  const confidenceColor =
    confidence === 'high' ? 'green' : confidence === 'medium' ? 'yellow' : 'red';

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
            toolCallsByPhase={toolCallsByPhase}
            budgetSnapshot={budgetSnapshot}
          />
        )}
      </Stack>
    </Drawer>
  );
}
