import TelegramBot from 'node-telegram-bot-api';
import { serializeError } from 'serialize-error';

import Alert from '@/models/alert';
import { AlertState } from '@/models/alert';
import Team from '@/models/team';
import logger from '@/utils/logger';

interface TelegramTeamConfig {
  botToken: string;
  webhookUrl: string;
  webhookSecret: string;
}

export interface Message {
  title: string;
  body: string;
  hdxLink: string;
  state: string;
  startTime: number;
  endTime: number;
  eventId: string;
}

// Cache bot instances per team to avoid re-creating
const botInstances = new Map<string, TelegramBot>();

const getBot = (config: TelegramTeamConfig): TelegramBot => {
  const cached = botInstances.get(config.botToken);
  if (cached) return cached;

  const bot = new TelegramBot(config.botToken);
  botInstances.set(config.botToken, bot);
  return bot;
};

const escapeMarkdownV2 = (text: string): string => {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
};

const formatAlertMessage = (message: Message): string => {
  const stateEmoji = message.state === AlertState.ALERT ? '\u{1F534}' : '\u{1F7E2}';
  const startDate = new Date(message.startTime).toISOString();
  const endDate = new Date(message.endTime).toISOString();

  return [
    `${stateEmoji} *${escapeMarkdownV2(message.title)}*`,
    '',
    escapeMarkdownV2(message.body),
    '',
    `\u{1F4C5} ${escapeMarkdownV2(startDate)} \\- ${escapeMarkdownV2(endDate)}`,
  ].join('\n');
};

const buildInlineKeyboard = (
  alertId: string,
  hdxLink: string,
): TelegramBot.InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: '\u{1F50D} View in HyperDX', url: hdxLink },
      { text: '\u{1F515} Silence 1h', callback_data: `silence:${alertId}` },
      { text: '\u2705 Acknowledge', callback_data: `ack:${alertId}` },
    ],
  ],
});

export const getTeamTelegramConfig = async (
  teamId: string,
): Promise<TelegramTeamConfig | null> => {
  const team = await Team.findById(teamId).select('telegramConfig').lean();
  return (team as any)?.telegramConfig || null;
};

export const sendAlertMessage = async (
  teamId: string,
  chatId: string,
  alertId: string,
  message: Message,
): Promise<void> => {
  const config = await getTeamTelegramConfig(teamId);
  if (!config) {
    logger.error({ teamId }, 'Telegram not configured for team');
    return;
  }

  const bot = getBot(config);
  const text = formatAlertMessage(message);
  const keyboard = buildInlineKeyboard(alertId, message.hdxLink);

  try {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  } catch (e) {
    logger.error(
      { error: serializeError(e), chatId, teamId },
      'Failed to send Telegram alert message',
    );
  }
};

export const validateChatId = async (
  teamId: string,
  chatId: string,
): Promise<{ ok: boolean; error?: string }> => {
  const config = await getTeamTelegramConfig(teamId);
  if (!config) {
    return {
      ok: false,
      error:
        'Telegram bot not configured. Set up in Settings → Integrations → Telegram.',
    };
  }

  const bot = getBot(config);
  try {
    await bot.sendMessage(
      chatId,
      '\u2705 HyperDX alert test message\\. Your Telegram integration is working\\!',
      { parse_mode: 'MarkdownV2' },
    );
    return { ok: true };
  } catch (e: any) {
    const errMsg =
      e?.response?.body?.description || e?.message || 'Unknown error';
    logger.error(
      { error: serializeError(e), chatId, teamId },
      'Telegram chat ID validation failed',
    );
    return { ok: false, error: errMsg };
  }
};

export const handleCallback = async (
  teamId: string,
  callbackQuery: TelegramBot.CallbackQuery,
): Promise<void> => {
  const data = callbackQuery.data;
  if (!data) return;

  const [action, alertId] = data.split(':');
  if (!alertId) return;

  const username =
    callbackQuery.from.username || callbackQuery.from.first_name || 'Unknown';

  const config = await getTeamTelegramConfig(teamId);
  if (!config) return;
  const bot = getBot(config);

  try {
    if (action === 'silence') {
      const now = new Date();
      const until = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
      await Alert.findByIdAndUpdate(alertId, {
        $set: {
          silenced: {
            by: `telegram:@${username}`,
            at: now,
            until,
          },
        },
      });
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `Alert silenced for 1 hour by @${username}`,
      });
      if (callbackQuery.message) {
        const originalText = callbackQuery.message.text || '';
        await bot.editMessageText(
          `${originalText}\n\n\u{1F515} _Silenced for 1h by @${escapeMarkdownV2(username)}_`,
          {
            chat_id: callbackQuery.message.chat.id,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'MarkdownV2',
          },
        );
      }
    } else if (action === 'ack') {
      const now = new Date();
      const until = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
      await Alert.findByIdAndUpdate(alertId, {
        $set: {
          silenced: {
            by: `telegram:@${username}`,
            at: now,
            until,
          },
        },
      });
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: `Alert acknowledged by @${username}`,
      });
      if (callbackQuery.message) {
        const originalText = callbackQuery.message.text || '';
        await bot.editMessageText(
          `${originalText}\n\n\u2705 _Acknowledged by @${escapeMarkdownV2(username)}_`,
          {
            chat_id: callbackQuery.message.chat.id,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'MarkdownV2',
          },
        );
      }
    }
  } catch (e) {
    logger.error(
      { error: serializeError(e), action, alertId },
      'Failed to handle Telegram callback',
    );
  }
};

// Register webhook with Telegram on startup/config change
export const registerWebhook = async (
  config: TelegramTeamConfig,
): Promise<{ ok: boolean; error?: string }> => {
  const bot = getBot(config);
  try {
    await bot.setWebHook(config.webhookUrl, {
      secret_token: config.webhookSecret,
    });
    return { ok: true };
  } catch (e: any) {
    logger.error(
      { error: serializeError(e) },
      'Failed to register Telegram webhook',
    );
    return {
      ok: false,
      error: e?.message || 'Failed to register webhook',
    };
  }
};

// Validate bot token by calling getMe
export const validateBotToken = async (
  botToken: string,
): Promise<{ ok: boolean; botName?: string; error?: string }> => {
  try {
    const bot = new TelegramBot(botToken);
    const me = await bot.getMe();
    return { ok: true, botName: me.username };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Invalid bot token' };
  }
};
