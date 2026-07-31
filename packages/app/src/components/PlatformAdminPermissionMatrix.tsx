import {
  hasPermission,
  PERMISSION_CATEGORIES,
  resolvePermissions,
} from '@hyperdx/common-utils/dist/permissions';
import {
  Badge,
  Box,
  Button,
  Group,
  ScrollArea,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';

import { CsvExportButton } from './CsvExportButton';

interface PlatformAdminMember {
  _id?: string;
  email: string;
  isSuperAdmin?: boolean;
  permissionOverrides?: {
    grants?: string[];
    revokes?: string[];
  };
  roleId?: {
    name?: string;
    permissions?: string[];
  } | null;
}

function getEffectivePermissions(member: PlatformAdminMember) {
  if (member.isSuperAdmin) return ['*:*'];

  return resolvePermissions(
    member.roleId?.permissions ?? [],
    member.permissionOverrides?.grants ?? [],
    member.permissionOverrides?.revokes ?? [],
  );
}

export function summarizePermissionCategory(
  member: Pick<
    PlatformAdminMember,
    'isSuperAdmin' | 'permissionOverrides' | 'roleId'
  >,
  permissions: readonly string[],
) {
  const effectivePermissions = getEffectivePermissions({
    email: '',
    ...member,
  });

  return {
    enabled: permissions.filter(permission =>
      hasPermission(effectivePermissions, permission),
    ).length,
    total: permissions.length,
  };
}

export default function PlatformAdminPermissionMatrix({
  members,
}: {
  members: PlatformAdminMember[];
}) {
  const csvData = members.map(member => {
    const effectivePermissions = getEffectivePermissions(member);
    return {
      Member: member.email,
      Role: member.isSuperAdmin
        ? 'Super Admin'
        : (member.roleId?.name ?? 'No role'),
      'Super Admin': member.isSuperAdmin ? 'Yes' : 'No',
      ...Object.fromEntries(
        PERMISSION_CATEGORIES.map(category => {
          const enabled = category.permissions.filter(permission =>
            hasPermission(effectivePermissions, permission),
          ).length;
          return [category.label, `${enabled}/${category.permissions.length}`];
        }),
      ),
    };
  });

  return (
    <Box ml="xl" mb="md">
      <Group justify="space-between" mb="xs">
        <Text size="sm" fw={500}>
          Effective Permission Matrix
        </Text>
        <CsvExportButton
          data={csvData}
          filename="platform-admin-permission-matrix"
        >
          <Button
            variant="subtle"
            size="compact-sm"
            leftSection={<IconDownload size={14} />}
          >
            Download CSV
          </Button>
        </CsvExportButton>
      </Group>
      <ScrollArea>
        <Table withTableBorder withColumnBorders highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Member</Table.Th>
              <Table.Th>Role</Table.Th>
              {PERMISSION_CATEGORIES.map(category => (
                <Table.Th key={category.label}>{category.label}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {members.map(member => (
              <Table.Tr key={member._id ?? member.email}>
                <Table.Td miw={190}>
                  <Text size="sm">{member.email}</Text>
                </Table.Td>
                <Table.Td miw={120}>
                  <Group gap="xs" wrap="nowrap">
                    <Badge variant="light" size="sm">
                      {member.isSuperAdmin
                        ? 'Super Admin'
                        : (member.roleId?.name ?? 'No role')}
                    </Badge>
                    {!!(
                      member.permissionOverrides?.grants?.length ||
                      member.permissionOverrides?.revokes?.length
                    ) && (
                      <Tooltip label="This user has permission overrides">
                        <Badge variant="light" color="yellow" size="xs">
                          Overrides
                        </Badge>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
                {PERMISSION_CATEGORIES.map(category => {
                  const summary = summarizePermissionCategory(
                    member,
                    category.permissions,
                  );
                  const effectivePermissions = getEffectivePermissions(member);
                  const enabledPermissions = category.permissions.filter(
                    permission =>
                      hasPermission(effectivePermissions, permission),
                  );

                  return (
                    <Table.Td key={category.label} ta="center">
                      <Tooltip
                        multiline
                        label={
                          enabledPermissions.length
                            ? enabledPermissions.join(', ')
                            : 'No access'
                        }
                      >
                        <Badge
                          variant="light"
                          color={
                            summary.enabled === summary.total
                              ? 'green'
                              : summary.enabled
                                ? 'yellow'
                                : 'gray'
                          }
                        >
                          {summary.enabled}/{summary.total}
                        </Badge>
                      </Tooltip>
                    </Table.Td>
                  );
                })}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Box>
  );
}
