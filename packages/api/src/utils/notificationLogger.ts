import mongoose from 'mongoose';

import NotificationLog, {
  INotificationLog,
} from '@/models/notificationLog';
import logger from '@/utils/logger';

interface LogNotificationParams {
  teamId: mongoose.Types.ObjectId;
  channel: 'email' | 'webhook';
  recipient: string;
  trigger: { type: string; id: string; name: string };
  subject: string;
  payload: Record<string, unknown>;
  actorId?: mongoose.Types.ObjectId | null;
  retryOf?: mongoose.Types.ObjectId | null;
}

export async function createNotificationEntry(
  params: LogNotificationParams,
): Promise<INotificationLog> {
  try {
    return await NotificationLog.create({
      ...params,
      status: 'pending',
      actorId: params.actorId ?? null,
      retryOf: params.retryOf ?? null,
    });
  } catch (err) {
    logger.error({ err, params }, 'Failed to create notification log entry');
    throw err;
  }
}

export async function markNotificationSuccess(
  id: mongoose.Types.ObjectId,
  response?: Record<string, unknown>,
): Promise<void> {
  try {
    await NotificationLog.updateOne(
      { _id: id },
      { status: 'success', response: response ?? {} },
    );
  } catch (err) {
    logger.error({ err, id }, 'Failed to mark notification as success');
  }
}

export async function markNotificationFailed(
  id: mongoose.Types.ObjectId,
  error: string,
  response?: Record<string, unknown>,
): Promise<void> {
  try {
    await NotificationLog.updateOne(
      { _id: id },
      { status: 'failed', error, response: response ?? {} },
    );
  } catch (err) {
    logger.error({ err, id }, 'Failed to mark notification as failed');
  }
}
