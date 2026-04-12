import {
  ActionIcon,
  Divider,
  Group,
  SegmentedControl,
  Tooltip,
} from '@mantine/core';
import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';

import type { LoopPhase } from '../../hooks/useInvestigationStream';

const PHASES: LoopPhase[] = ['plan', 'execute', 'verify', 'summarize'];

interface ReplayControlsProps {
  isReplay: boolean;
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  onSetSpeed: (speed: 1 | 5 | 10) => void;
  onJumpToPhase: (phase: LoopPhase) => void;
}

export function ReplayControls({
  isReplay,
  isPaused,
  onPause,
  onResume,
  onSetSpeed,
  onJumpToPhase,
}: ReplayControlsProps) {
  if (!isReplay) return null;

  return (
    <Group gap="xs" mb="sm" wrap="nowrap">
      <Tooltip label={isPaused ? 'Resume' : 'Pause'}>
        <ActionIcon
          variant="secondary"
          size="sm"
          onClick={isPaused ? onResume : onPause}
        >
          {isPaused ? (
            <IconPlayerPlay size={14} />
          ) : (
            <IconPlayerPause size={14} />
          )}
        </ActionIcon>
      </Tooltip>

      <SegmentedControl
        size="xs"
        data={[
          { value: '1', label: '1x' },
          { value: '5', label: '5x' },
          { value: '10', label: '10x' },
        ]}
        defaultValue="1"
        onChange={v => onSetSpeed(Number(v) as 1 | 5 | 10)}
      />

      <Divider orientation="vertical" />

      <SegmentedControl
        size="xs"
        data={PHASES.map(p => ({
          value: p,
          label: p[0].toUpperCase() + p.slice(1),
        }))}
        onChange={v => onJumpToPhase(v as LoopPhase)}
      />
    </Group>
  );
}
