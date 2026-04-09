import { Button, Section, Text, Hr } from '@react-email/components';
import * as React from 'react';
import { render } from '@react-email/components';
import { hyperdxTheme } from '../theme/hyperdxTheme';

import { Layout } from './components/Layout';

interface AlertNotificationProps {
  title: string;
  body: string;
  hdxLink: string;
  state: 'ALERT' | 'OK';
  startTime: string;
  endTime: string;
}

function AlertNotificationEmail({
  title,
  body,
  hdxLink,
  state,
  startTime,
  endTime,
}: AlertNotificationProps) {
  const isResolved = state === 'OK';

  return (
    <Layout preview={title}>
      <Section style={headerSectionStyle}>
        <Text
          style={{
            ...stateBadgeStyle,
            backgroundColor: isResolved
              ? hyperdxTheme.colors.green[6]
              : '#e03e3e',
          }}
        >
          {isResolved ? 'RESOLVED' : 'ALERT'}
        </Text>
      </Section>

      <Section style={sectionStyle}>
        <Text style={titleStyle}>{title}</Text>

        <Section style={timeRangeContainerStyle}>
          <Text style={timeRangeLabelStyle}>Time Range (UTC)</Text>
          <Text style={timeRangeValueStyle}>
            {startTime} — {endTime}
          </Text>
        </Section>

        <Hr style={hrStyle} />

        <Text style={bodyLabelStyle}>Details</Text>
        <Section style={bodyContainerStyle}>
          <Text style={bodyTextStyle}>{body}</Text>
        </Section>

        <Button style={buttonStyle} href={hdxLink}>
          View in HyperDX
        </Button>
      </Section>
    </Layout>
  );
}

export async function renderAlertNotification(props: AlertNotificationProps) {
  const html = await render(<AlertNotificationEmail {...props} />);
  const text = `${props.title}\n\nTime Range (UTC): ${props.startTime} — ${props.endTime}\n\n${props.body}\n\nView in HyperDX: ${props.hdxLink}`;
  return { html, text };
}

const sectionStyle = { padding: '0 24px' };
const headerSectionStyle = { padding: '20px 24px 0' };

const stateBadgeStyle = {
  display: 'inline-block',
  padding: '6px 16px',
  borderRadius: '4px',
  color: hyperdxTheme.white,
  fontSize: hyperdxTheme.fontSizes.sm,
  fontWeight: 'bold' as const,
  fontFamily: hyperdxTheme.fontFamily,
};

const titleStyle = {
  fontSize: hyperdxTheme.fontSizes.lg,
  fontWeight: 'bold' as const,
  color: hyperdxTheme.colors.dark[0],
  lineHeight: '28px',
  marginBottom: '16px',
  fontFamily: hyperdxTheme.fontFamily,
};

const timeRangeContainerStyle = {
  background: hyperdxTheme.colors.dark[4],
  borderRadius: '6px',
  padding: '12px 16px',
  marginBottom: '16px',
};

const timeRangeLabelStyle = {
  fontSize: hyperdxTheme.fontSizes.xs,
  color: hyperdxTheme.colors.gray[5],
  margin: '0 0 4px 0',
  fontFamily: hyperdxTheme.fontFamily,
};

const timeRangeValueStyle = {
  fontSize: hyperdxTheme.fontSizes.sm,
  color: hyperdxTheme.colors.dark[0],
  margin: 0,
  fontFamily: hyperdxTheme.fontFamily,
};

const hrStyle = {
  borderColor: hyperdxTheme.colors.dark[3],
  margin: '20px 0',
};

const bodyLabelStyle = {
  fontSize: hyperdxTheme.fontSizes.sm,
  color: hyperdxTheme.colors.gray[5],
  margin: '0 0 8px 0',
  fontFamily: hyperdxTheme.fontFamily,
};

const bodyContainerStyle = {
  background: hyperdxTheme.colors.dark[5],
  borderRadius: '6px',
  padding: '16px',
  marginBottom: '20px',
};

const bodyTextStyle = {
  margin: 0,
  fontSize: hyperdxTheme.fontSizes.sm,
  color: hyperdxTheme.colors.dark[0],
  fontFamily: 'monospace',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-all' as const,
  overflowWrap: 'break-word' as const,
};

const buttonStyle = {
  backgroundColor: hyperdxTheme.colors.green[6],
  borderRadius: '6px',
  color: hyperdxTheme.white,
  fontSize: '16px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '14px 24px',
  fontFamily: hyperdxTheme.fontFamily,
};
