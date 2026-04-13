import { useState } from 'react';
import {
  Box,
  Button,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBrandTelegram } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';

import api from '@/api';
import { usePermission } from '@/hooks/usePermission';

export default function TelegramSection() {
  const { data: configData, isLoading } = api.useTelegramConfig();
  const updateConfig = api.useUpdateTelegramConfig();
  const queryClient = useQueryClient();
  const canManageIntegrations = usePermission('integrations:manage');

  const existing = configData?.data;

  const [botToken, setBotToken] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');

  const handleSave = async () => {
    if (!botToken && !existing?.botToken) {
      notifications.show({ color: 'red', message: 'Bot token is required' });
      return;
    }
    if (!webhookUrl) {
      notifications.show({ color: 'red', message: 'Webhook URL is required' });
      return;
    }
    try {
      await updateConfig.mutateAsync({
        botToken: botToken || existing?.botToken || '',
        webhookUrl,
      });
      queryClient.invalidateQueries({ queryKey: ['team', 'telegram-config'] });
      notifications.show({
        color: 'green',
        message: 'Telegram configuration saved',
      });
      setBotToken('');
    } catch {
      notifications.show({
        color: 'red',
        message: 'Failed to save Telegram configuration',
      });
    }
  };

  if (isLoading) {
    return (
      <Box>
        <Group gap="xs" mb="sm">
          <IconBrandTelegram size={20} />
          <Text fw={500} size="sm">
            Telegram
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          Loading...
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Group gap="xs" mb="sm">
        <IconBrandTelegram size={20} />
        <Text fw={500} size="sm">
          Telegram
        </Text>
      </Group>
      <Stack gap="sm">
        <PasswordInput
          size="xs"
          label="Bot Token"
          description="Create a bot via @BotFather on Telegram. Send /newbot and copy the token."
          placeholder={existing?.botToken || 'Enter bot token'}
          value={botToken}
          onChange={e => setBotToken(e.currentTarget.value)}
        />
        <TextInput
          size="xs"
          label="Webhook URL"
          description="Your ClickStack public URL + /api/v1/telegram/callback. Must be HTTPS."
          placeholder="https://your-domain.com/api/v1/telegram/callback"
          value={webhookUrl}
          onChange={e => setWebhookUrl(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button
            size="xs"
            variant="primary"
            onClick={handleSave}
            loading={updateConfig.isPending}
            disabled={!canManageIntegrations}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Box>
  );
}
