import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Box,
  Button,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';

import {
  useInvestigation,
  useInvestigationChat,
} from '../../hooks/useInvestigations';
import { useInvestigationStream } from '../../hooks/useInvestigationStream';

import { DebugDrawer } from './DebugDrawer';
import InvestigationMessage from './InvestigationMessage';

interface InvestigationChatProps {
  investigationId: string;
  sourceId: string;
}

export default function InvestigationChat({
  investigationId,
  sourceId,
}: InvestigationChatProps) {
  const { data: investigation } = useInvestigation(investigationId);
  const { sendMessage, isStreaming, streamedText, toolEvents, cancel } =
    useInvestigationChat(investigationId);
  const [input, setInput] = useState('');
  const viewportRef = useRef<HTMLDivElement>(null);
  const [debugOpened, { open: openDebug, close: closeDebug }] =
    useDisclosure(false);
  // Pass isOwner=false until user session hook is available
  const streamState = useInvestigationStream(investigationId ?? null, false);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    viewportRef.current?.scrollTo({
      top: viewportRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [investigation?.messages, streamedText]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim(), sourceId);
    setInput('');
  }, [input, isStreaming, sendMessage, sourceId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <Stack h="100%" gap={0}>
      <DebugDrawer
        opened={debugOpened}
        onClose={closeDebug}
        investigationId={investigationId}
        isOwner={false}
        {...streamState}
      />
      {/* Header */}
      <Box
        px="md"
        py="xs"
        style={{
          borderBottom: '1px solid var(--mantine-color-dark-4)',
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <Button size="xs" variant="subtle" onClick={openDebug}>
          Debug
        </Button>
      </Box>
      {/* Messages area */}
      <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef}>
        <Stack gap="md" p="md">
          {investigation?.messages.map((msg, i) => (
            <InvestigationMessage key={i} message={msg} />
          ))}

          {/* Streaming response */}
          {isStreaming && (
            <Box style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
              {toolEvents.map((te, i) => (
                <Text key={i} size="xs" c="dimmed" mb="xs">
                  {'\u{1F527}'} {te.name}(
                  {JSON.stringify(te.args).slice(0, 100)})
                </Text>
              ))}
              {streamedText ? (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {streamedText}
                </Text>
              ) : (
                <Loader size="sm" />
              )}
            </Box>
          )}
        </Stack>
      </ScrollArea>

      {/* Input area */}
      <Box
        p="md"
        style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}
      >
        <Box style={{ display: 'flex', gap: 8 }}>
          <Textarea
            style={{ flex: 1 }}
            placeholder="Ask about this trace, search logs, find root cause..."
            value={input}
            onChange={e => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            autosize
            minRows={1}
            maxRows={4}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <ActionIcon variant="subtle" onClick={cancel} size="lg" mt="auto">
              {'\u23F9'}
            </ActionIcon>
          ) : (
            <ActionIcon
              variant="primary"
              onClick={handleSend}
              size="lg"
              mt="auto"
              disabled={!input.trim()}
            >
              {'\u2192'}
            </ActionIcon>
          )}
        </Box>
      </Box>
    </Stack>
  );
}
