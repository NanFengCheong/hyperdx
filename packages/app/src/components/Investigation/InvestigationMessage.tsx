import {
  Badge,
  Box,
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { memo } from 'react';

interface ToolCall {
  name: string;
  args: unknown;
  result: unknown;
}

interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  timestamp: string;
}

function ToolCallDisplay({ toolCall }: { toolCall: ToolCall }) {
  const [opened, { toggle }] = useDisclosure(false);

  return (
    <Paper p="xs" withBorder style={{ cursor: 'pointer' }} onClick={toggle}>
      <Group gap="xs">
        <Badge size="xs" variant="outline">
          Tool
        </Badge>
        <Text size="xs" fw={500}>
          {toolCall.name}
        </Text>
      </Group>
      <Collapse in={opened}>
        <Box mt="xs">
          <Text size="xs" c="dimmed">
            Args: {JSON.stringify(toolCall.args, null, 2)}
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            Result: {String(toolCall.result).slice(0, 500)}
            {String(toolCall.result).length > 500 ? '...' : ''}
          </Text>
        </Box>
      </Collapse>
    </Paper>
  );
}

function InvestigationMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <Box
      style={{
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
      }}
    >
      <Paper p="sm" radius="md" bg={isUser ? 'blue.9' : 'dark.6'}>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <Stack gap="xs" mb="xs">
            {message.toolCalls.map((tc, i) => (
              <ToolCallDisplay key={i} toolCall={tc} />
            ))}
          </Stack>
        )}
        {isUser ? (
          <Text size="sm">{message.content}</Text>
        ) : (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {message.content}
          </Text>
        )}
      </Paper>
      <Text size="xs" c="dimmed" mt={2}>
        {new Date(message.timestamp).toLocaleTimeString()}
      </Text>
    </Box>
  );
}

export default memo(InvestigationMessage);
