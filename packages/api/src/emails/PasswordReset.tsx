import { Button, Section, Text } from '@react-email/components';
import { render } from '@react-email/components';
import * as React from 'react';

import { hyperdxTheme } from '../theme/hyperdxTheme';
import { Layout } from './components/Layout';

interface PasswordResetProps {
  name: string;
  code: string;
  magicLink: string;
}

function PasswordResetEmail({ name, code, magicLink }: PasswordResetProps) {
  return (
    <Layout preview="Reset your HyperDX password">
      <Section style={sectionStyle}>
        <Text style={textStyle}>Hi {name},</Text>
        <Text style={textStyle}>Enter this code to reset your password:</Text>
        <Section style={codeContainerStyle}>
          <Text style={codeStyle}>{code}</Text>
        </Section>
        <Text style={textStyle}>This code expires in 5 minutes.</Text>
        <Text style={textStyle}>
          Or click the button below to reset instantly:
        </Text>
        <Button style={buttonStyle} href={magicLink}>
          Reset Password
        </Button>
      </Section>
    </Layout>
  );
}

export async function renderPasswordReset(props: PasswordResetProps) {
  const html = await render(<PasswordResetEmail {...props} />);
  const text = `Hi ${props.name},\n\nYour password reset code is: ${props.code}\n\nThis code expires in 5 minutes.\n\nOr reset instantly: ${props.magicLink}`;
  return { html, text };
}

const sectionStyle = { padding: '0 24px' };
const textStyle = {
  fontSize: hyperdxTheme.fontSizes.md,
  color: hyperdxTheme.colors.dark[0],
  lineHeight: '24px',
  fontFamily: hyperdxTheme.fontFamily,
};
const codeContainerStyle = {
  background: hyperdxTheme.colors.dark[4],
  borderRadius: '8px',
  margin: '20px 0',
  padding: '20px',
  textAlign: 'center' as const,
};
const codeStyle = {
  fontSize: '28px',
  fontWeight: 'bold' as const,
  letterSpacing: '8px',
  color: hyperdxTheme.white,
  fontFamily: 'monospace',
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
