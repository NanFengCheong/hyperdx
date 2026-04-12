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
  const startedAtRef = useRef(startedAt);
  startedAtRef.current = startedAt;

  useEffect(() => {
    const currentStartedAt = startedAtRef.current;
    if (isActive && currentStartedAt != null) {
      const baseElapsed = Date.now() - currentStartedAt; // eslint-disable-line no-restricted-syntax -- intentional real-time elapsed calculation in interval, not render
      setElapsed(baseElapsed);
      intervalRef.current = setInterval(() => {
        setElapsed(Date.now() - currentStartedAt); // eslint-disable-line no-restricted-syntax -- intentional real-time elapsed calculation in interval, not render
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startedAt tracked via ref, only isActive triggers effect
  }, [isActive]);

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
          {isActive && startedAt ? (
            <Text size="xs" c="dimmed">
              {formatElapsed(elapsed)}
            </Text>
          ) : null}
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
