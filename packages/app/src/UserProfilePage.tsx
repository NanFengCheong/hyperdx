import { useMemo } from 'react';
import Head from 'next/head';
import {
  Avatar,
  Badge,
  Card,
  Code,
  Container,
  Divider,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { PERMISSION_CATEGORIES } from '@hyperdx/common-utils/dist/permissions';

import api from './api';
import { PageHeader } from './components/PageHeader';
import { usePermissions } from './contexts/PermissionContext';
import { withAppNav } from './layout';

function UserProfilePage() {
  const { data: me } = api.useMe();
  const { data: team } = api.useTeam();
  const { permissions, dataScopes, isSuperAdmin, roleName, isLoading, can } =
    usePermissions();
  const {
    data: rawPermData,
    error: permError,
    isLoading: isPermLoading,
  } = api.useMyPermissions();

  const userInitials = useMemo(() => {
    const name = me?.name ?? me?.email ?? '';
    return name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(n => n.charAt(0).toUpperCase())
      .join('');
  }, [me]);

  return (
    <>
      <Head>
        <title>User Profile</title>
      </Head>
      <Container size="md" py="xl">
        <PageHeader>User Profile</PageHeader>

        <Card withBorder mb="lg">
          <Group align="flex-start" gap="lg">
            <Avatar size="lg" radius="xl" color="gray">
              {userInitials || 'U'}
            </Avatar>
            <Stack gap={4} style={{ flex: 1 }}>
              <Text fw={600} size="lg">
                {me?.name ?? 'Loading...'}
              </Text>
              <Text size="sm" c="dimmed">
                {me?.email}
              </Text>
              <Group gap="xs" mt={4}>
                <Badge variant="light" color="blue" tt="none">
                  {(team as any)?.name ?? 'No team'}
                </Badge>
                <Badge variant="light" tt="none">
                  {roleName ?? 'No role'}
                </Badge>
                {isSuperAdmin && (
                  <Badge variant="filled" color="green" tt="none">
                    Super Admin
                  </Badge>
                )}
              </Group>
            </Stack>
          </Group>
        </Card>

        <Title order={4} mb="sm">
          Permissions
        </Title>

        {isLoading || isPermLoading ? (
          <Text c="dimmed">Loading permissions...</Text>
        ) : (
          <>
            {dataScopes.length > 0 && (
              <Card withBorder mb="md">
                <Text fw={600} size="sm" mb="xs">
                  Data Scopes
                </Text>
                <Group gap="xs">
                  {dataScopes.map(s => (
                    <Badge key={s} variant="outline" tt="none">
                      {s}
                    </Badge>
                  ))}
                </Group>
              </Card>
            )}

            <Card withBorder mb="md">
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Permission</Table.Th>
                    <Table.Th style={{ textAlign: 'center' }}>
                      Granted
                    </Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {PERMISSION_CATEGORIES.map(cat =>
                    cat.permissions.map((perm, i) => (
                      <Table.Tr key={perm}>
                        {i === 0 && (
                          <Table.Td rowSpan={cat.permissions.length}>
                            <Text fw={600} size="sm">
                              {cat.label}
                            </Text>
                          </Table.Td>
                        )}
                        <Table.Td>
                          <Code>{perm}</Code>
                        </Table.Td>
                        <Table.Td style={{ textAlign: 'center' }}>
                          {can(perm) ? (
                            <Badge color="green" variant="filled" size="sm">
                              Yes
                            </Badge>
                          ) : (
                            <Badge color="red" variant="light" size="sm">
                              No
                            </Badge>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    )),
                  )}
                </Table.Tbody>
              </Table>
            </Card>

            <Card withBorder>
              <Text fw={600} size="sm" mb="xs">
                Raw API Response
              </Text>
              {permError ? (
                <Code block color="red">
                  {`Error: ${permError.message}`}
                </Code>
              ) : (
                <Code block>{JSON.stringify(rawPermData, null, 2)}</Code>
              )}
            </Card>

            <Divider my="md" />
            <Text size="xs" c="dimmed">
              Resolved permissions: [{permissions.join(', ')}]
            </Text>
          </>
        )}
      </Container>
    </>
  );
}

UserProfilePage.getLayout = withAppNav;

export default UserProfilePage;
