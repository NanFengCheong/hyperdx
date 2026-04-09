import mongoose from 'mongoose';
import nodemailer from 'nodemailer';

import * as config from '@/config';
import { renderAlertNotification } from '@/emails/AlertNotification';
import { renderLoginVerification } from '@/emails/LoginVerification';
import { renderPasswordReset } from '@/emails/PasswordReset';
import { renderTeamInvite } from '@/emails/TeamInvite';
import {
  createNotificationEntry,
  markNotificationFailed,
  markNotificationSuccess,
} from '@/utils/notificationLogger';
import logger from '@/utils/logger';

let transporter: nodemailer.Transporter | null = null;

export function getTransporter(): nodemailer.Transporter | null {
  if (!config.SMTP_ENABLED) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER
        ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
        : undefined,
    });
  }
  return transporter;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface NotificationContext {
  teamId: mongoose.Types.ObjectId;
  trigger: { type: string; id: string; name: string };
  actorId?: mongoose.Types.ObjectId | null;
  retryOf?: mongoose.Types.ObjectId | null;
}

async function sendEmail(
  options: SendEmailOptions,
  context?: NotificationContext,
): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) {
    logger.warn('SMTP not configured, skipping email send');
    return true; // no-op success
  }

  let logEntry: any = null;
  if (context) {
    try {
      logEntry = await createNotificationEntry({
        teamId: context.teamId,
        channel: 'email',
        recipient: options.to,
        trigger: context.trigger,
        subject: options.subject,
        payload: { html: options.html, text: options.text },
        actorId: context.actorId,
        retryOf: context.retryOf,
      });
    } catch {
      // logging failure should not block email send
    }
  }

  try {
    const info = await transport.sendMail({
      from: `"${config.SMTP_FROM_NAME}" <${config.SMTP_FROM}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    logger.info({ to: options.to, subject: options.subject }, 'Email sent');
    if (logEntry) {
      await markNotificationSuccess(logEntry._id, {
        messageId: info.messageId,
        response: info.response,
      });
    }
    return true;
  } catch (error) {
    logger.error({ err: error, to: options.to }, 'Failed to send email');
    if (logEntry) {
      await markNotificationFailed(
        logEntry._id,
        error instanceof Error ? error.message : String(error),
      );
    }
    return false;
  }
}

export async function sendLoginVerificationEmail(
  to: string,
  name: string,
  code: string,
  magicLink: string,
  context?: NotificationContext,
): Promise<boolean> {
  const { html, text } = await renderLoginVerification({
    name,
    code,
    magicLink,
  });
  return sendEmail(
    {
      to,
      subject: `Your verification code: ${code}`,
      html,
      text,
    },
    context,
  );
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  code: string,
  magicLink: string,
  context?: NotificationContext,
): Promise<boolean> {
  const { html, text } = await renderPasswordReset({ name, code, magicLink });
  return sendEmail(
    {
      to,
      subject: 'Reset your password',
      html,
      text,
    },
    context,
  );
}

export async function sendTeamInviteEmail(
  to: string,
  invitedByEmail: string,
  joinUrl: string,
  context?: NotificationContext,
): Promise<boolean> {
  const { html, text } = await renderTeamInvite({ invitedByEmail, joinUrl });
  return sendEmail(
    {
      to,
      subject: `You've been invited to join a team on HyperDX`,
      html,
      text,
    },
    context,
  );
}

interface AlertNotificationEmailOptions {
  to: string;
  name: string;
  title: string;
  body: string;
  hdxLink: string;
  state: 'ALERT' | 'OK';
  startTime: string;
  endTime: string;
}

export async function sendAlertNotificationEmail(
  options: AlertNotificationEmailOptions,
  context?: NotificationContext,
): Promise<boolean> {
  const { html, text } = await renderAlertNotification({
    title: options.title,
    body: options.body,
    hdxLink: options.hdxLink,
    state: options.state,
    startTime: options.startTime,
    endTime: options.endTime,
  });
  const subject =
    options.state === 'OK' ? `Resolved: ${options.title}` : options.title;
  return sendEmail(
    {
      to: options.to,
      subject,
      html,
      text,
    },
    context,
  );
}
