import { Button, Section, Text } from '@react-email/components';
import { render } from '@react-email/components';
import * as React from 'react';

import { hyperdxTheme } from '../theme/hyperdxTheme';
import { Layout } from './components/Layout';

interface TeamInviteProps {
  invitedByEmail: string;
  joinUrl: string;
}

function TeamInviteEmail({ invitedByEmail, joinUrl }: TeamInviteProps) {
  return (
    <Layout
      preview={`${invitedByEmail} invited you to join their team on HyperDX`}
    >
      <Section style={sectionStyle}>
        <Text style={textStyle}>
          <strong>{invitedByEmail}</strong> has invited you to join their team
          on HyperDX.
        </Text>
        <Text style={textStyle}>
          Click the button below to accept the invitation and create your
          account:
        </Text>
        <Button style={buttonStyle} href={joinUrl}>
          Join Team
        </Button>
        <Text style={subtextStyle}>
          This invite link will expire in 30 days.
        </Text>
      </Section>
    </Layout>
  );
}

export async function renderTeamInvite(props: TeamInviteProps) {
  const html = await render(<TeamInviteEmail {...props} />);
  const text = `${props.invitedByEmail} has invited you to join their team on HyperDX.\n\nJoin your team: ${props.joinUrl}\n\nThis invite link will expire in 30 days.`;
  return { html, text };
}

const sectionStyle = { padding: '0 24px' };
const textStyle = {
  fontSize: hyperdxTheme.fontSizes.md,
  color: hyperdxTheme.colors.dark[0],
  lineHeight: '24px',
  fontFamily: hyperdxTheme.fontFamily,
};
const subtextStyle = {
  fontSize: hyperdxTheme.fontSizes.sm,
  color: hyperdxTheme.colors.gray[5],
  lineHeight: '20px',
  fontFamily: hyperdxTheme.fontFamily,
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
  margin: '16px 0',
  fontFamily: hyperdxTheme.fontFamily,
};
