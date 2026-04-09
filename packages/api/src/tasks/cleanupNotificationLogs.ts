import NotificationLog from '@/models/notificationLog';
import PlatformSetting from '@/models/platformSetting';
import logger from '@/utils/logger';

const DEFAULT_RETENTION_DAYS = 30;

export async function cleanupNotificationLogs(): Promise<void> {
  try {
    const setting = await PlatformSetting.findOne({
      key: 'notificationLogRetentionDays',
    });
    const retentionDays = (setting?.value as number) ?? DEFAULT_RETENTION_DAYS;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const result = await NotificationLog.deleteMany({
      createdAt: { $lt: cutoff },
    });

    logger.info(
      { deletedCount: result.deletedCount, retentionDays },
      'Notification log cleanup complete',
    );
  } catch (err) {
    logger.error({ err }, 'Notification log cleanup failed');
  }
}
