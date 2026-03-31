import Head from 'next/head';
import {
  Center,
  Container,
  Stack,
  Tabs,
  Text,
  Title,
} from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';

import { useIsSuperAdmin } from './hooks/usePermission';
import { withAppNav } from './layout';
import { useBrandDisplayName } from './theme/ThemeProvider';

function AccessDenied() {
  return (
    <Center h="60vh">
      <Stack align="center" gap="sm">
        <IconShieldLock size={48} opacity={0.3} />
        <Title order={3}>Access Denied</Title>
        <Text c="dimmed" size="sm">
          You do not have permission to access this page. Platform Admin is
          restricted to super administrators.
        </Text>
      </Stack>
    </Center>
  );
}

export default function AdminPage() {
  const brandName = useBrandDisplayName();
  const isSuperAdmin = useIsSuperAdmin();

  if (!isSuperAdmin) {
    return <AccessDenied />;
  }

  return (
    <div data-testid="admin-page">
      <Head>
        <title>Platform Admin - {brandName}</title>
      </Head>
      <Container maw={1200} py="lg" px="lg">
        <Title order={2} mb="lg">
          Platform Admin
        </Title>

        <Tabs defaultValue="teams">
          <Tabs.List mb="lg">
            <Tabs.Tab value="teams">Teams</Tabs.Tab>
            <Tabs.Tab value="audit-log">Global Audit Log</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="teams">
            {/* TODO: Add full admin API hooks (e.g. useAdminTeams) and build
                out team management UI with create/edit/delete capabilities */}
            <Stack align="center" gap="sm" py="xl">
              <IconShieldLock size={40} opacity={0.3} />
              <Text size="lg" fw={500}>
                Team Management
              </Text>
              <Text c="dimmed" size="sm">
                Platform Admin &mdash; Coming Soon
              </Text>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="audit-log">
            {/* TODO: Add global audit log viewer with filtering by team,
                user, action type, and date range */}
            <Stack align="center" gap="sm" py="xl">
              <IconShieldLock size={40} opacity={0.3} />
              <Text size="lg" fw={500}>
                Global Audit Log
              </Text>
              <Text c="dimmed" size="sm">
                Platform Admin &mdash; Coming Soon
              </Text>
            </Stack>
          </Tabs.Panel>
        </Tabs>
      </Container>
    </div>
  );
}

AdminPage.getLayout = withAppNav;
