import { Accordion, ScrollArea, Text } from '@mantine/core';

import type { LoopPhase } from '../../hooks/useInvestigationStream';

const PHASES: LoopPhase[] = ['plan', 'execute', 'verify', 'summarize'];

interface ThinkingBlockProps {
  isOwner: boolean;
  thinkingByPhase: Record<string, { content: string; tokenCount: number }>;
  phase?: LoopPhase;
}

export function ThinkingBlock({
  isOwner,
  thinkingByPhase,
  phase,
}: ThinkingBlockProps) {
  if (!isOwner) return null;

  // If a specific phase is requested, show only that phase
  const phases = phase
    ? PHASES.filter(p => p === phase && thinkingByPhase[p])
    : PHASES.filter(p => thinkingByPhase[p]);

  if (phases.length === 0) return null;

  return (
    <Accordion variant="separated" radius="sm">
      {phases.map(p => (
        <Accordion.Item key={p} value={p}>
          <Accordion.Control>
            <Text size="xs" fw={500}>
              {p} thinking ({thinkingByPhase[p].tokenCount} tokens)
            </Text>
          </Accordion.Control>
          <Accordion.Panel>
            <ScrollArea mah={300}>
              <Text
                size="xs"
                style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}
              >
                {thinkingByPhase[p].content}
              </Text>
            </ScrollArea>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}
