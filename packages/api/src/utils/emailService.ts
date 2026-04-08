import nodemailer from 'nodemailer';

import { renderLoginVerification } from '@/emails/LoginVerification';
import { renderPasswordReset } from '@/emails/PasswordReset';
import * as config from '@/config';
import logger from '@/utils/logger';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!config.SMTP_ENABLED) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth:
        config.SMTP_USER
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

async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) {
    logger.warn('SMTP not configured, skipping email send');
    return true; // no-op success
  }

  try {
    await transport.sendMail({
      from: `"${config.SMTP_FROM_NAME}" <${config.SMTP_FROM}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });
    logger.info({ to: options.to, subject: options.subject }, 'Email sent');
    return true;
  } catch (error) {
    logger.error({ err: error, to: options.to }, 'Failed to send email');
    return false;
  }
}

export async function sendLoginVerificationEmail(
  to: string,
  name: string,
  code: string,
  magicLink: string,
): Promise<boolean> {
  const { html, text } = await renderLoginVerification({ name, code, magicLink });
  return sendEmail({
    to,
    subject: `Your verification code: ${code}`,
    html,
    text,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  code: string,
  magicLink: string,
): Promise<boolean> {
  const { html, text } = await renderPasswordReset({ name, code, magicLink });
  return sendEmail({
    to,
    subject: 'Reset your password',
    html,
    text,
  });
}
