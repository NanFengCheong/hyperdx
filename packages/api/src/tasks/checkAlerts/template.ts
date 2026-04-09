import { ClickhouseClient } from '@hyperdx/common-utils/dist/clickhouse/node';
import { Metadata } from '@hyperdx/common-utils/dist/core/metadata';
import { renderChartConfig } from '@hyperdx/common-utils/dist/core/renderChartConfig';
import {
  _useTry,
  formatDate,
  objectHash,
} from '@hyperdx/common-utils/dist/core/utils';
import {
  AlertChannelType,
  ChartConfigWithOptDateRange,
  DisplayType,
  pickSampleWeightExpressionProps,
  SourceKind,
  WebhookService,
  zAlertChannelType,
} from '@hyperdx/common-utils/dist/types';
import { isValidSlackUrl } from '@hyperdx/common-utils/dist/validation';
import Handlebars, { HelperOptions } from 'handlebars';
import _ from 'lodash';
import mongoose from 'mongoose';
import PromisedHandlebars from 'promised-handlebars';
import { serializeError } from 'serialize-error';
import { z } from 'zod';

import * as config from '@/config';
import { AlertInput } from '@/controllers/alerts';
import { AlertSource, AlertState, AlertThresholdType } from '@/models/alert';
import { IDashboard } from '@/models/dashboard';
import { ISavedSearch } from '@/models/savedSearch';
import { ISource } from '@/models/source';
import { IUser } from '@/models/user';
import { IWebhook } from '@/models/webhook';
import { sendAlertMessage } from '@/services/telegram';
import {
  computeAliasWithClauses,
  doesExceedThreshold,
} from '@/tasks/checkAlerts';
import {
  AlertProvider,
  PopulatedAlertChannel,
} from '@/tasks/checkAlerts/providers';
import { escapeJsonString, unflattenObject } from '@/tasks/util';
import { truncateString } from '@/utils/common';
import {
  NotificationContext,
  sendAlertNotificationEmail,
} from '@/utils/emailService';
import logger from '@/utils/logger';
import {
  createNotificationEntry,
  markNotificationFailed,
  markNotificationSuccess,
} from '@/utils/notificationLogger';
import * as slack from '@/utils/slack';

const MAX_MESSAGE_LENGTH = 500;
const NOTIFY_FN_NAME = '__hdx_notify_channel__';
const IS_MATCH_FN_NAME = 'is_match';

/**
 * Creates a Handlebars instance with common helpers registered.
 * Use this to ensure consistent helper availability across all template rendering.
 */
const createHandlebarsWithHelpers = () => {
  const hb = Handlebars.create();
  // Register eq helper for conditional checks (e.g., {{#if (eq state "ALERT")}})
  hb.registerHelper('eq', (a, b) => a === b);
  return hb;
};

const zNotifyFnParams = z.object({
  hash: z.object({
    channel: zAlertChannelType,
    id: z.string(),
  }),
});

// should match the external alert schema
export type AlertMessageTemplateDefaultView = {
  alert: AlertInput;
  attributes: ReturnType<typeof unflattenObject>;
  dashboard?: IDashboard | null;
  endTime: Date;
  granularity: string;
  group?: string;
  isGroupedAlert: boolean;
  savedSearch?: ISavedSearch | null;
  source?: ISource | null;
  startTime: Date;
  value: number;
};

interface Message {
  hdxLink: string;
  title: string;
  body: string;
  state: AlertState;
  startTime: number;
  endTime: number;
  eventId: string;
}

export const isAlertResolved = (state?: AlertState): boolean => {
  return state === AlertState.OK;
};

/**
 * Formats the value to match the decimal precision of the threshold.
 * This ensures consistent display of numbers in alert messages.
 * Uses Intl.NumberFormat for better precision handling with large numbers.
 */
export const formatValueToMatchThreshold = (
  value: number,
  threshold: number,
): string => {
  // Format threshold with NumberFormat to get its string representation
  const thresholdFormatted = new Intl.NumberFormat('en-US', {
    maximumSignificantDigits: 21,
    useGrouping: false,
  }).format(threshold);

  // Count decimal places in the formatted threshold
  const decimalIndex = thresholdFormatted.indexOf('.');
  const decimalPlaces =
    decimalIndex === -1 ? 0 : thresholdFormatted.length - decimalIndex - 1;

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
    useGrouping: false,
  }).format(value);
};

const notifyChannel = async ({
  channel,
  message,
  notificationContext,
}: {
  channel: PopulatedAlertChannel;
  message: Message;
  notificationContext?: NotificationContext;
}) => {
  switch (channel.type) {
    case 'webhook': {
      const webhook = channel.channel;
      // TODO: migrate to use handleSendGenericWebhook so templates can be used
      if (webhook.service === WebhookService.Slack) {
        await handleSendSlackWebhook(webhook, message);
      } else if (
        webhook.service === WebhookService.Generic ||
        webhook.service === WebhookService.IncidentIO
      ) {
        await handleSendGenericWebhook(webhook, message, notificationContext);
      }
      break;
    }
    case 'email': {
      await handleSendEmail(channel.users, message, notificationContext);
      break;
    }
    case 'telegram': {
      await sendAlertMessage(
        channel.teamId,
        channel.chatId,
        message.eventId,
        message,
      );
      break;
    }
    default:
      throw new Error(
        `Unsupported channel type: ${(channel as { type: string }).type}`,
      );
  }
};

const blacklistedWebhookHosts = (() => {
  const map = new Map<string, string>();
  const configKeys = ['CLICKHOUSE_HOST', 'MONGO_URI'];
  for (const configKey of configKeys) {
    // ignore errors
    const [_, e] = _useTry(() =>
      map.set(new URL(config[configKey]).host, configKey),
    );
  }
  return map;
})();

function validateWebhookUrl(
  webhook: IWebhook,
): asserts webhook is IWebhook & { url: string } {
  if (!webhook.url) {
    throw new Error('Webhook URL is not set');
  }

  if (webhook.service === WebhookService.Slack) {
    // check that hostname ends in "slack.com"
    if (!isValidSlackUrl(webhook.url)) {
      const message = `Slack Webhook URL ${webhook.url} does not have hostname that ends in 'slack.com'`;
      logger.warn(
        {
          webhook: {
            id: webhook._id.toString(),
            name: webhook.name,
            url: webhook.url,
            body: webhook.body,
          },
        },
        message,
      );
      throw new Error(`SSRF AllowedDomainError: ${message}`);
    }
  } else {
    // check webhookurl host is not blacklisted
    const url = new URL(webhook.url);
    if (blacklistedWebhookHosts.has(url.host)) {
      const message = `Webhook attempting to query blacklisted route ${blacklistedWebhookHosts.get(
        url.host,
      )}`;
      logger.warn(
        {
          webhook: {
            id: webhook._id.toString(),
            name: webhook.name,
            url: webhook.url,
            body: webhook.body,
          },
        },
        message,
      );
      throw new Error(`SSRF AllowedDomainError: ${message}`);
    }
  }
}

export const handleSendSlackWebhook = async (
  webhook: IWebhook,
  message: Message,
) => {
  validateWebhookUrl(webhook);

  await slack.postMessageToWebhook(webhook.url, {
    text: message.title,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${message.hdxLink} | ${message.title}>*\n${message.body}`,
        },
      },
    ],
  });
};

export const handleSendGenericWebhook = async (
  webhook: IWebhook,
  message: Message,
  notificationContext?: NotificationContext,
) => {
  validateWebhookUrl(webhook);

  let url: string;
  // user input of queryParams is disabled on the frontend for now
  if (webhook.queryParams) {
    // user may have included params in both the url and the query params
    // so they should be merged
    const tmpURL = new URL(webhook.url);
    for (const [key, value] of Object.entries(webhook.queryParams.toJSON())) {
      tmpURL.searchParams.append(key, value);
    }

    url = tmpURL.toString();
  } else {
    // if there are no query params given, just use the url
    url = webhook.url;
  }

  // HEADERS
  // TODO: handle real webhook security and signage after v0
  // X-HyperDX-Signature FROM PRIVATE SHA-256 HMAC, time based nonces, caching functionality etc

  const headers = {
    'Content-Type': 'application/json', // default, will be overwritten if user has set otherwise
    ...(webhook.headers?.toJSON() ?? {}),
  };
  // BODY
  let body = '';
  try {
    const handlebars = createHandlebarsWithHelpers();

    body = handlebars.compile(webhook.body, {
      noEscape: true,
    })({
      body: escapeJsonString(message.body),
      endTime: message.endTime,
      eventId: message.eventId,
      link: escapeJsonString(message.hdxLink),
      startTime: message.startTime,
      state: message.state,
      title: escapeJsonString(message.title),
    });
  } catch (e) {
    logger.error(
      {
        error: serializeError(e),
      },
      'Failed to compile generic webhook body',
    );
    return;
  }

  // Create notification log entry before sending
  let logEntry: any = null;
  if (notificationContext) {
    try {
      logEntry = await createNotificationEntry({
        teamId: notificationContext.teamId as mongoose.Types.ObjectId,
        channel: 'webhook',
        recipient: url,
        trigger: notificationContext.trigger,
        subject: message.title,
        payload: { body, headers: webhook.headers?.toJSON() },
        actorId: notificationContext.actorId,
        retryOf: notificationContext.retryOf,
      });
    } catch {
      // logging failure should not block webhook send
    }
  }

  try {
    // TODO: retries/backoff etc -> switch to request-error-tolerant api client
    const response = await fetch(url, {
      method: 'POST',
      headers: headers as Record<string, string>,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const errorMsg = `HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText.slice(0, 500)}` : ''}`;
      if (logEntry) {
        await markNotificationFailed(logEntry._id, errorMsg, {
          status: response.status,
          body: errorText.slice(0, 1000),
        });
      }
      throw new Error(errorText);
    }

    if (logEntry) {
      await markNotificationSuccess(logEntry._id, {
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (e) {
    if (logEntry && !(e instanceof Error && e.message.startsWith('HTTP '))) {
      await markNotificationFailed(
        logEntry._id,
        e instanceof Error ? e.message : String(e),
      );
    }
    logger.error(
      {
        error: serializeError(e),
      },
      'Failed to send generic webhook message',
    );
  }
};

export const handleSendEmail = async (
  users: IUser[],
  message: Message,
  notificationContext?: NotificationContext,
) => {
  if (users.length === 0) {
    logger.warn('No recipients for email notification');
    return;
  }

  // Use MYT (Malaysia Time, UTC+8) for all datetime formatting
  const startTimeStr = formatDate(new Date(message.startTime), {
    timezone: 'Asia/Kuala_Lumpur',
  });
  const endTimeStr = formatDate(new Date(message.endTime), {
    timezone: 'Asia/Kuala_Lumpur',
  });

  for (const user of users) {
    try {
      await sendAlertNotificationEmail(
        {
          to: user.email,
          name: user.name,
          title: message.title,
          body: message.body,
          hdxLink: message.hdxLink,
          state: message.state as 'ALERT' | 'OK',
          startTime: startTimeStr,
          endTime: endTimeStr,
        },
        notificationContext,
      );
    } catch (e) {
      logger.error(
        {
          error: serializeError(e),
          userId: user._id?.toString(),
          email: user.email,
        },
        'Failed to send alert notification email',
      );
    }
  }
};

export const buildAlertMessageTemplateHdxLink = (
  alertProvider: AlertProvider,
  {
    alert,
    dashboard,
    endTime,
    granularity,
    savedSearch,
    startTime,
  }: AlertMessageTemplateDefaultView,
) => {
  if (alert.source === AlertSource.SAVED_SEARCH) {
    if (savedSearch == null) {
      throw new Error(`Source is ${alert.source} but savedSearch is null`);
    }
    return alertProvider.buildLogSearchLink({
      endTime,
      savedSearch,
      startTime,
    });
  } else if (alert.source === AlertSource.TILE) {
    if (dashboard == null) {
      throw new Error(`Source is ${alert.source} but dashboard is null`);
    }
    return alertProvider.buildChartLink({
      dashboardId: dashboard.id,
      endTime,
      granularity,
      startTime,
    });
  }

  throw new Error(`Unsupported alert source: ${(alert as any).source}`);
};

export const buildAlertMessageTemplateTitle = ({
  template,
  view,
  state,
}: {
  template?: string | null;
  view: AlertMessageTemplateDefaultView;
  state?: AlertState;
}) => {
  const { alert, dashboard, savedSearch, value } = view;
  const handlebars = createHandlebarsWithHelpers();

  const statePrefix = isAlertResolved(state) ? 'Resolved: ' : '';

  if (alert.source === AlertSource.SAVED_SEARCH) {
    if (savedSearch == null) {
      throw new Error(`Source is ${alert.source}  but savedSearch is null`);
    }
    // TODO: using template engine to render the title
    const baseTitle = template
      ? handlebars.compile(template)(view)
      : `Alert for "${savedSearch.name}" - ${value} lines found`;
    return `${statePrefix}${baseTitle}`;
  } else if (alert.source === AlertSource.TILE) {
    if (dashboard == null) {
      throw new Error(`Source is ${alert.source} but dashboard is null`);
    }
    const tile = dashboard.tiles.find(t => t.id === alert.tileId);
    if (!tile) {
      throw new Error(
        `Tile with id ${alert.tileId} not found in dashboard ${dashboard.name}`,
      );
    }
    const formattedValue = formatValueToMatchThreshold(value, alert.threshold);
    const baseTitle = template
      ? handlebars.compile(template)(view)
      : `Alert for "${tile.config.name}" in "${dashboard.name}" - ${formattedValue} ${
          doesExceedThreshold(alert.thresholdType, alert.threshold, value)
            ? alert.thresholdType === AlertThresholdType.ABOVE
              ? 'exceeds'
              : 'falls below'
            : alert.thresholdType === AlertThresholdType.ABOVE
              ? 'falls below'
              : 'exceeds'
        } ${alert.threshold}`;
    return `${statePrefix}${baseTitle}`;
  }

  throw new Error(`Unsupported alert source: ${(alert as any).source}`);
};

export const getDefaultExternalAction = (
  alert: AlertMessageTemplateDefaultView['alert'],
) => {
  if (alert.channel.type === 'webhook' && alert.channel.webhookId != null) {
    return `@${alert.channel.type}-${alert.channel.webhookId}`;
  }
  if (alert.channel.type === 'email') {
    if (alert.channel.entireTeam) {
      return `@${alert.channel.type}-__entireTeam__`;
    }
    if (alert.channel.userIds != null) {
      return `@${alert.channel.type}-${alert.channel.userIds.join(',')}`;
    }
  }
  return null;
};

export const translateExternalActionsToInternal = (template: string) => {
  // ex: @webhook-1234_5678 -> "{{NOTIFY_FN_NAME channel="webhook" id="1234_5678}}"
  // ex: @webhook-{{attributes.webhookId}} -> "{{NOTIFY_FN_NAME channel="webhook" id="{{attributes.webhookId}}"}}"
  return template.replace(/(?:^|\s)@([a-zA-Z0-9.{}@_-]+)/g, (match, input) => {
    const prefix = match.startsWith(' ') ? ' ' : '';
    const [channel, ...ids] = input.split('-');
    const id = ids.join('-');
    // TODO: sanity check ??
    return `${prefix}{{${NOTIFY_FN_NAME} channel="${channel}" id="${id}"}}`;
  });
};

const findWebhookByName = (
  channelIdOrNamePrefix: string,
  teamWebhooksById: Map<string, IWebhook>,
) => {
  return [...teamWebhooksById.values()].find(w =>
    w.name.startsWith(channelIdOrNamePrefix),
  );
};

const getPopulatedChannel = (
  channelType: AlertChannelType,
  channelIdOrUserIds: string | string[],
  teamWebhooksById: Map<string, IWebhook>,
  teamUsersById: Map<string, IUser>,
  teamId: string,
): PopulatedAlertChannel | undefined => {
  switch (channelType) {
    case 'webhook': {
      const webhook =
        teamWebhooksById.get(channelIdOrUserIds as string) ??
        findWebhookByName(channelIdOrUserIds as string, teamWebhooksById);

      if (!webhook) {
        logger.error(
          {
            webhookId: channelIdOrUserIds,
          },
          'webhook not found',
        );
        return undefined;
      }
      return { type: 'webhook', channel: webhook };
    }
    case 'email': {
      const userIds = Array.isArray(channelIdOrUserIds)
        ? channelIdOrUserIds
        : [channelIdOrUserIds];

      // When entireTeam flag is set and the special marker is present,
      // resolve all team members instead of individual userIds
      if (userIds.length === 1 && userIds[0] === '__entireTeam__') {
        const users = [...teamUsersById.values()];
        if (users.length === 0) {
          logger.error('no users found for entire team email channel');
          return undefined;
        }
        return { type: 'email', users };
      }

      const users = userIds
        .map(id => teamUsersById.get(id))
        .filter((u): u is IUser => u != null);

      if (users.length === 0) {
        logger.error({ userIds }, 'no users found for email channel');
        return undefined;
      }
      return { type: 'email', users };
    }
    case 'telegram': {
      const chatId = Array.isArray(channelIdOrUserIds)
        ? channelIdOrUserIds[0]
        : channelIdOrUserIds;
      if (!chatId || !teamId) {
        logger.error(
          { chatId, teamId },
          'missing chatId or teamId for telegram channel',
        );
        return undefined;
      }
      return { type: 'telegram', chatId, teamId };
    }
    default: {
      logger.error({ channelType }, 'Unsupported alert channel type');
      return undefined;
    }
  }
};

// this method will build the body of the alert message and will be used to send the alert to the channel
export const renderAlertTemplate = async ({
  alertProvider,
  clickhouseClient,
  metadata,
  state,
  teamId,
  template,
  title,
  view,
  teamWebhooksById,
  teamUsersById,
  notificationContext,
}: {
  alertProvider: AlertProvider;
  clickhouseClient: ClickhouseClient;
  metadata: Metadata;
  state: AlertState;
  teamId: string;
  template?: string | null;
  title: string;
  view: AlertMessageTemplateDefaultView;
  teamWebhooksById: Map<string, IWebhook>;
  teamUsersById: Map<string, IUser>;
  notificationContext?: NotificationContext;
}) => {
  const {
    alert,
    dashboard,
    endTime,
    group,
    savedSearch,
    source,
    startTime,
    value,
  } = view;

  const defaultExternalAction = getDefaultExternalAction(alert);
  const targetTemplate =
    defaultExternalAction !== null
      ? translateExternalActionsToInternal(
          `${template ?? ''} ${defaultExternalAction}`,
        ).trim()
      : translateExternalActionsToInternal(template ?? '');

  const isMatchFn = function (shouldRender: boolean) {
    return function (
      targetKey: string,
      targetValue: string,
      options: HelperOptions,
    ) {
      if (_.has(view, targetKey) && _.get(view, targetKey) === targetValue) {
        if (shouldRender) {
          return options.fn(this);
        } else {
          options.fn(this);
        }
      }
    };
  };
  const _hb = createHandlebarsWithHelpers();
  _hb.registerHelper(NOTIFY_FN_NAME, () => null);
  _hb.registerHelper(IS_MATCH_FN_NAME, isMatchFn(true));
  const hb = PromisedHandlebars(Handlebars);
  const registerHelpers = (rawTemplateBody: string) => {
    hb.registerHelper(IS_MATCH_FN_NAME, isMatchFn(false));

    // Register a custom helper which sends notifications to the specified channel
    // Usage: {{NOTIFY_FN_NAME channel="webhook" id="1234_5678"}}
    hb.registerHelper(NOTIFY_FN_NAME, async (options: unknown) => {
      const { hash } = zNotifyFnParams.parse(options);
      const { channel: channelType, id: idTemplate } = hash;

      // The id field can also be a template itself, e.g. id="{{attributes.webhookId}}", so it must be compiled and rendered
      // The id might also be the prefix of the webhook name.
      const renderedIdOrNamePrefix = _hb.compile(idTemplate)(view);

      // render body template
      const renderedBody = _hb.compile(rawTemplateBody)(view);

      const channel = getPopulatedChannel(
        channelType,
        // For email channels, the id is a comma-separated list of user IDs
        channelType === 'email'
          ? renderedIdOrNamePrefix.split(',')
          : renderedIdOrNamePrefix,
        teamWebhooksById,
        teamUsersById,
        teamId,
      );

      if (channel) {
        const startTime = view.startTime.getTime();
        const endTime = view.endTime.getTime();

        const eventId = objectHash({
          alertId: alert.id,
          channel: {
            type: channel.type,
            // For email, use a hash of user IDs as the channel identifier
            id:
              channel.type === 'email'
                ? channel.users.map(u => u._id.toString()).join(',')
                : channel.type === 'telegram'
                  ? channel.chatId
                  : channel.channel._id.toString(),
          },
          // Explicitly track if this is a grouped alert
          isGrouped: view.isGroupedAlert,
          ...(view.isGroupedAlert && group ? { groupId: group } : {}),
        });

        await notifyChannel({
          channel,
          message: {
            hdxLink: buildAlertMessageTemplateHdxLink(alertProvider, view),
            title,
            body: renderedBody,
            state,
            startTime,
            endTime,
            eventId,
          },
          notificationContext,
        });
      }
    });
  };

  const timeRangeMessage = `Time Range (MYT): [${formatDate(view.startTime, {
    timezone: 'Asia/Kuala_Lumpur',
  })} - ${formatDate(view.endTime, {
    timezone: 'Asia/Kuala_Lumpur',
  })})`;
  let rawTemplateBody;

  // For resolved alerts, use a simple message instead of fetching data
  if (isAlertResolved(state)) {
    rawTemplateBody = `${group ? `Group: "${group}" - ` : ''}The alert has been resolved.\n${timeRangeMessage}
${targetTemplate}`;
  }
  // TODO: support advanced routing with template engine
  // users should be able to use '@' syntax to trigger alerts
  else if (alert.source === AlertSource.SAVED_SEARCH) {
    if (savedSearch == null) {
      throw new Error(`Source is ${alert.source} but savedSearch is null`);
    }
    if (source == null) {
      throw new Error(`Source ID is ${alert.source} but source is null`);
    }
    if (source.kind !== SourceKind.Log && source.kind !== SourceKind.Trace) {
      throw new Error(
        `Expecting SourceKind 'trace' or 'log', got ${source.kind}`,
      );
    }
    // TODO: show group + total count for group-by alerts
    // fetch sample logs
    const resolvedSelect =
      savedSearch.select || source.defaultTableSelectExpression || '';
    const chartConfig: ChartConfigWithOptDateRange = {
      connection: '', // no need for the connection id since clickhouse client is already initialized
      displayType: DisplayType.Search,
      dateRange: [startTime, endTime],
      from: source.from,
      select: resolvedSelect,
      where: savedSearch.where,
      whereLanguage: savedSearch.whereLanguage,
      implicitColumnExpression: source.implicitColumnExpression,
      ...pickSampleWeightExpressionProps(source),
      timestampValueExpression: source.timestampValueExpression,
      orderBy: savedSearch.orderBy,
      limit: {
        limit: 5,
        offset: 0,
      },
    };

    let truncatedResults = '';
    try {
      const aliasWith = await computeAliasWithClauses(
        savedSearch,
        source,
        metadata,
      );
      if (aliasWith) {
        chartConfig.with = aliasWith;
      }
      const query = await renderChartConfig(
        chartConfig,
        metadata,
        source.querySettings,
      );
      const raw = await clickhouseClient
        .query<'CSV'>({
          query: query.sql,
          query_params: query.params,
          format: 'CSV',
        })
        .then(res => res.text());

      const lines = raw.split('\n');

      truncatedResults = truncateString(
        lines.map(line => truncateString(line, MAX_MESSAGE_LENGTH)).join('\n'),
        2500,
      );
    } catch (e) {
      logger.error(
        {
          savedSearchId: savedSearch.id,
          chartConfig,
          error: serializeError(e),
        },
        'Failed to fetch sample logs',
      );
    }

    rawTemplateBody = `${group ? `Group: "${group}"` : ''}
${value} lines found, expected ${
      alert.thresholdType === AlertThresholdType.ABOVE
        ? 'less than'
        : 'greater than'
    } ${alert.threshold} lines\n${timeRangeMessage}
${targetTemplate}
\`\`\`
${truncatedResults}
\`\`\``;
  } else if (alert.source === AlertSource.TILE) {
    if (dashboard == null) {
      throw new Error(`Source is ${alert.source} but dashboard is null`);
    }
    const formattedValue = formatValueToMatchThreshold(value, alert.threshold);
    rawTemplateBody = `${group ? `Group: "${group}"` : ''}
${formattedValue} ${
      doesExceedThreshold(alert.thresholdType, alert.threshold, value)
        ? alert.thresholdType === AlertThresholdType.ABOVE
          ? 'exceeds'
          : 'falls below'
        : alert.thresholdType === AlertThresholdType.ABOVE
          ? 'falls below'
          : 'exceeds'
    } ${alert.threshold}\n${timeRangeMessage}
${targetTemplate}`;
  }

  // render the template
  if (rawTemplateBody) {
    registerHelpers(rawTemplateBody);
    const compiledTemplate = hb.compile(rawTemplateBody);
    return compiledTemplate(view);
  }

  throw new Error(`Unsupported alert source: ${(alert as any).source}`);
};
