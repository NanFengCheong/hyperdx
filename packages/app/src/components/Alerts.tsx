import React from 'react';
import { useMemo } from 'react';
import { Control, useController } from 'react-hook-form';
import { MultiSelect, Select, SelectProps } from 'react-hook-form-mantine';
import { Label, ReferenceArea, ReferenceLine } from 'recharts';
import {
  type AlertChannelType,
  type TeamMember,
  WebhookService,
} from '@hyperdx/common-utils/dist/types';
import {
  ActionIcon,
  Button,
  Checkbox,
  ComboboxData,
  Group,
  Modal,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconBrandTelegram, IconSend } from '@tabler/icons-react';

import api from '@/api';

import { WebhookForm } from '../components/TeamSettings/WebhookForm';

type Webhook = {
  _id: string;
  name: string;
};

const WebhookChannelForm = <T extends object>(
  props: Partial<SelectProps<T>>,
) => {
  const { data: webhooks, refetch: refetchWebhooks } = api.useWebhooks([
    WebhookService.Slack,
    WebhookService.Generic,
    WebhookService.IncidentIO,
  ]);
  const [opened, { open, close }] = useDisclosure(false);

  const hasWebhooks = Array.isArray(webhooks?.data) && webhooks.data.length > 0;

  const options = useMemo<ComboboxData>(() => {
    const webhookOptions =
      webhooks?.data.map((sw: Webhook) => ({
        value: sw._id,
        label: sw.name,
      })) || [];

    return [
      {
        value: '',
        label: 'Select a Webhook',
        disabled: true,
      },
      ...webhookOptions,
    ];
  }, [webhooks]);

  const { field } = useController({
    control: props.control,
    name: props.name!,
  });

  const handleWebhookCreated = async (webhookId?: string) => {
    await refetchWebhooks();
    if (webhookId) {
      field.onChange(webhookId);
      field.onBlur();
    }
    close();
  };

  return (
    <div>
      <Group gap="md" justify="space-between">
        <Select
          data-testid="select-webhook"
          comboboxProps={{
            withinPortal: false,
          }}
          required
          size="xs"
          flex={1}
          placeholder={
            hasWebhooks ? 'Select a Webhook' : 'No Webhooks available'
          }
          data={options}
          name={props.name!}
          control={props.control}
          {...props}
        />
        <Button
          data-testid="add-new-webhook-button"
          size="xs"
          variant="subtle"
          color="gray"
          onClick={open}
        >
          Add New Incoming Webhook
        </Button>
      </Group>

      <Modal
        data-testid="alert-modal"
        opened={opened}
        onClose={close}
        title="Add New Webhook"
        centered
        zIndex={9999}
        size="lg"
      >
        <WebhookForm onClose={close} onSuccess={handleWebhookCreated} />
      </Modal>
    </div>
  );
};

const EmailChannelForm = ({
  control,
  namePrefix = '',
}: {
  control: Control<any>;
  namePrefix?: string;
}) => {
  const { data: teamMembers } = api.useTeamMembers();

  const { field: entireTeamField } = useController({
    control,
    name: `${namePrefix}channel.entireTeam`,
    defaultValue: false,
  });
  const { field: userIdsField } = useController({
    control,
    name: `${namePrefix}channel.userIds`,
    defaultValue: [],
  });
  const entireTeam = entireTeamField.value === true;

  const options = useMemo(
    () =>
      ((teamMembers?.data || []) as TeamMember[]).map((m: TeamMember) => ({
        value: m._id,
        label: `${m.name || m.email} (${m.email})`,
      })),
    [teamMembers?.data],
  );

  return (
    <div>
      <Checkbox
        data-testid="entire-team-checkbox"
        size="xs"
        label="Notify entire team"
        checked={entireTeam}
        onChange={e => {
          entireTeamField.onChange(e.currentTarget.checked);
          if (e.currentTarget.checked) {
            userIdsField.onChange([]);
          }
        }}
        mb="xs"
      />
      {!entireTeam && (
        <MultiSelect
          data-testid="select-email-recipients"
          required
          size="xs"
          placeholder="Select team members to notify"
          data={options}
          name={`${namePrefix}channel.userIds`}
          control={control}
          comboboxProps={{
            withinPortal: false,
          }}
        />
      )}
    </div>
  );
};

const TelegramChannelForm = ({
  control,
  namePrefix = '',
}: {
  control: Control<any>;
  namePrefix?: string;
}) => {
  const { field } = useController({
    control,
    name: `${namePrefix}channel.chatId`,
    defaultValue: '',
  });

  const [testing, setTesting] = React.useState(false);

  const handleTest = async () => {
    if (!field.value) return;
    setTesting(true);
    try {
      const res = await fetch('/api/v1/telegram/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ chatId: field.value }),
      });
      const data = await res.json();
      if (data.ok) {
        notifications.show({
          color: 'green',
          message: 'Test message sent successfully!',
        });
      } else {
        notifications.show({
          color: 'red',
          message: data.error || 'Failed to send test message',
        });
      }
    } catch {
      notifications.show({
        color: 'red',
        message: 'Failed to validate chat ID',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <Group gap="md" align="flex-end">
        <TextInput
          size="xs"
          flex={1}
          label="Chat ID"
          description="Add the bot to your group, then use @RawDataBot or /chatid to get the group chat ID"
          placeholder="-1001234567890"
          value={field.value}
          onChange={field.onChange}
          onBlur={field.onBlur}
          required
        />
        <Tooltip label="Send test message">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={handleTest}
            loading={testing}
            disabled={!field.value}
          >
            <IconSend size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </div>
  );
};

export const AlertChannelForm = ({
  control,
  type,
  namePrefix = '',
}: {
  control: Control<any>; // TODO: properly type this
  type: AlertChannelType;
  namePrefix?: string;
}) => {
  if (type === 'webhook') {
    return (
      <WebhookChannelForm
        control={control}
        name={`${namePrefix}channel.webhookId`}
      />
    );
  }

  if (type === 'email') {
    return <EmailChannelForm control={control} namePrefix={namePrefix} />;
  }

  if (type === 'telegram') {
    return <TelegramChannelForm control={control} namePrefix={namePrefix} />;
  }

  return null;
};

export const getAlertReferenceLines = ({
  thresholdType,
  threshold,
  // TODO: zScore
}: {
  thresholdType: 'above' | 'below';
  threshold: number;
}) => {
  if (threshold != null && thresholdType === 'below') {
    return (
      <ReferenceArea
        y1={0}
        y2={threshold}
        ifOverflow="extendDomain"
        fill="red"
        strokeWidth={0}
        fillOpacity={0.05}
      />
    );
  }
  if (threshold != null && thresholdType === 'above') {
    return (
      <ReferenceArea
        y1={threshold}
        ifOverflow="extendDomain"
        fill="red"
        strokeWidth={0}
        fillOpacity={0.05}
      />
    );
  }
  if (threshold != null) {
    return (
      <ReferenceLine
        y={threshold}
        label={
          <Label
            value="Alert Threshold"
            fill={'white'}
            fontSize={11}
            opacity={0.7}
          />
        }
        stroke="red"
        strokeDasharray="3 3"
      />
    );
  }
  return null;
};
