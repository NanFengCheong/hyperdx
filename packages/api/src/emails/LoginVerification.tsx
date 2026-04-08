import { Button, Section, Text } from '@react-email/components';
import * as React from 'react';
import { render } from '@react-email/components';

import { Layout } from './components/Layout';

interface LoginVerificationProps {
  name: string;
  code: string;
  magicLink: string;
}

function LoginVerificationEmail({ name, code, magicLink }: LoginVerificationProps) {
  return (
    <Layout preview={`Your verification code is ${code}`}>
      <Section style={sectionStyle}>
        <Text style={textStyle}>Hi {name},</Text>
        <Text style={textStyle}>
          Enter this verification code to complete your login:
        </Text>
        <Section style={codeContainerStyle}>
          <Text style={codeStyle}>{code}</Text>
        </Section>
        <Text style={textStyle}>This code expires in 5 minutes.</Text>
        <Text style={textStyle}>Or click the button below to verify instantly:</Text>
        <Button style={buttonStyle} href={magicLink}>
          Verify Login
        </Button>
      </Section>
    </Layout>
  );
}

export async function renderLoginVerification(props: LoginVerificationProps) {
  const html = await render(<LoginVerificationEmail {...props} />);
  const text = `Hi ${props.name},\n\nYour verification code is: ${props.code}\n\nThis code expires in 5 minutes.\n\nOr verify instantly: ${props.magicLink}`;
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
