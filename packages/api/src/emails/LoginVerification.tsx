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
const textStyle = { fontSize: '16px', color: '#e0e0e0', lineHeight: '24px' };
const codeContainerStyle = {
  background: '#2d3142',
  borderRadius: '8px',
  margin: '20px 0',
  padding: '20px',
  textAlign: 'center' as const,
};
const codeStyle = {
  fontSize: '28px',
  fontWeight: 'bold' as const,
  letterSpacing: '8px',
  color: '#ffffff',
  fontFamily: 'monospace',
};
const buttonStyle = {
  backgroundColor: '#0ea5e9',
  borderRadius: '6px',
  color: '#fff',
  fontSize: '16px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
  textAlign: 'center' as const,
  display: 'block',
  padding: '14px 24px',
  margin: '16px 0',
};
