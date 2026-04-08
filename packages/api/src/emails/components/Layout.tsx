import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';

interface LayoutProps {
  preview: string;
  children: React.ReactNode;
}

export function Layout({ preview, children }: LayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            <Text style={logoStyle}>HyperDX</Text>
          </Section>
          {children}
          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            This is an automated message from HyperDX. If you didn&apos;t
            request this, you can safely ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: '#f6f9fc',
  fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
};

const containerStyle = {
  backgroundColor: '#ffffff',
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  maxWidth: '560px',
};

const headerStyle = {
  padding: '20px 48px 0',
};

const logoStyle = {
  fontSize: '24px',
  fontWeight: 'bold' as const,
  color: '#0ea5e9',
};

const hrStyle = {
  borderColor: '#e6ebf1',
  margin: '20px 48px',
};

const footerStyle = {
  color: '#8898aa',
  fontSize: '12px',
  padding: '0 48px',
};
