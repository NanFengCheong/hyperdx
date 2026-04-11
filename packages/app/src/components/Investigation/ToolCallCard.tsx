import { Badge, Box, Code, Collapse, Group, Stack, Text } from '@mantine/core';
import { useState } from 'react';

import type { ToolCallEntry } from '../../hooks/useInvestigationStream';

const TOOL_COLORS: Record<string, string> = {
  searchTraces: 'blue',
  getTraceDetail: 'blue',
  searchLogs: 'teal',
  getMetrics: 'violet',
  findSimilarErrors: 'orange',
  getServiceMap: 'cyan',
  getSessionReplay: 'indigo',
  createSavedSearch: 'green',
  createDashboard: 'green',
  createAlert: 'green',
  retrieveMemory: 'gray',
  getBaselineMetrics: 'violet',
  getServiceHealthScore: 'grape',
  getActiveAlerts: 'red',
};

export function ToolCallCard({ entry }: { entry: ToolCallEntry }) {
  const [expanded, setExpanded] = useState(entry.status === 'pending');
  const color = TOOL_COLORS[entry.tool] ?? 'gray';
  const hasError = entry.status === 'error';

  return (
    <Box
      style={{
        borderLeft: `3px solid var(--mantine-color-${hasError ? 'red' : color}-5)`,
        paddingLeft: 8,
        cursor: 'pointer',
      }}
      onClick={() => setExpanded(e => !e)}
    >
      <Group gap="xs" wrap="nowrap">
        <Badge size="xs" color={color} variant="light" style={{ flexShrink: 0 }}>
          {entry.tool}
        </Badge>
        {entry.status === 'pending' && (
          <Text size="xs" c="dimmed">
            running...
          </Text>
        )}
        {entry.durationMs !== undefined && (
          <Badge size="xs" color="gray" variant="outline">
            {entry.durationMs}ms
          </Badge>
        )}
        {hasError && (
          <Badge size="xs" color="red">
            error
          </Badge>
        )}
      </Group>

      <Collapse in={expanded}>
        <Stack gap={4} mt={4}>
          {Object.entries(entry.args).map(([k, v]) => (
            <Text key={k} size="xs" c="dimmed">
              {k}:{' '}
              <Text span c="white">
                {String(v)}
              </Text>
            </Text>
          ))}
          {entry.result !== undefined && (
            <Code block style={{ fontSize: 10, maxHeight: 120, overflow: 'auto' }}>
              {JSON.stringify(entry.result, null, 2).slice(0, 500)}
            </Code>
          )}
          {entry.error && (
            <Text size="xs" c="red">
              {entry.error}
            </Text>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}
