import { useEffect, useRef, useState } from 'react';
import { Group, Progress, Stack, Text } from '@mantine/core';

import type { BudgetSnapshot } from '../../hooks/useInvestigationStream';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function getProgressColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'yellow';
  return 'blue';
}

interface BudgetBarProps {
  budgetSnapshot?: BudgetSnapshot;
  isActive: boolean;
  startedAt?: number;
}

export function BudgetBar({
  budgetSnapshot,
  isActive,
  startedAt,
}: BudgetBarProps) {
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isActive && startedAt) {
      intervalRef.current = setInterval(() => {
        setElapsed(Date.now() - startedAt);
      }, 1000);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isActive, startedAt]);

  if (!budgetSnapshot) return null;

  const toolPct = Math.round(
    (budgetSnapshot.toolCallsUsed / budgetSnapshot.toolCallsTotal) * 100,
  );

  return (
    <Stack gap={4} mb="sm">
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          Tool calls
        </Text>
        <Group gap="xs">
          <Text size="xs">
            {budgetSnapshot.toolCallsUsed}/{budgetSnapshot.toolCallsTotal}
          </Text>
          {isActive && startedAt && (
            <Text size="xs" c="dimmed">
              {formatElapsed(elapsed)}
            </Text>
          )}
        </Group>
      </Group>
      <Progress
        value={toolPct}
        color={getProgressColor(toolPct)}
        size="sm"
        animated={isActive}
      />
    </Stack>
  );
}
