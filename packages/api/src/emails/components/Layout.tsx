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

import { hyperdxTheme } from '../../theme/hyperdxTheme';

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
  backgroundColor: hyperdxTheme.colors.dark[7],
  fontFamily: hyperdxTheme.fontFamily,
};

const containerStyle = {
  backgroundColor: hyperdxTheme.colors.dark[6],
  margin: '0 auto',
  padding: '20px 0 48px',
  marginBottom: '64px',
  width: '100%',
  maxWidth: '560px',
};

const headerStyle = {
  padding: '20px 24px 0',
};

const logoStyle = {
  fontSize: '24px',
  fontWeight: 'bold' as const,
  color: hyperdxTheme.colors.green[6],
  margin: '0',
};

const hrStyle = {
  borderColor: hyperdxTheme.colors.gray[8],
  margin: '20px 24px',
};

const footerStyle = {
  color: hyperdxTheme.colors.gray[5],
  fontSize: '12px',
  padding: '0 24px',
  lineHeight: '18px',
};
