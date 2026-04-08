import { Button, Section, Text } from '@react-email/components';
import * as React from 'react';
import { render } from '@react-email/components';

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
        <Text style={textStyle}>
          Enter this code to reset your password:
        </Text>
        <Section style={codeContainerStyle}>
          <Text style={codeStyle}>{code}</Text>
        </Section>
        <Text style={textStyle}>This code expires in 5 minutes.</Text>
        <Text style={textStyle}>Or click the button below to reset instantly:</Text>
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

const sectionStyle = { padding: '0 48px' };
const textStyle = { fontSize: '16px', color: '#525f7f' };
const codeContainerStyle = {
  background: '#f4f4f5',
  borderRadius: '8px',
  margin: '16px 0',
  padding: '16px',
  textAlign: 'center' as const,
};
const codeStyle = {
  fontSize: '32px',
  fontWeight: 'bold' as const,
  letterSpacing: '6px',
  color: '#1a1a1a',
  fontFamily: 'monospace',
};
const buttonStyle = {
  backgroundColor: '#0ea5e9',
  borderRadius: '5px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '12px 24px',
  margin: '16px 0',
};
