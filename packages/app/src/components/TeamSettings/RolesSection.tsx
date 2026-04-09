import { useState } from 'react';
import { HTTPError } from 'ky';
import { SYSTEM_ROLES } from '@hyperdx/common-utils/dist/permissions';
import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconPencil,
  IconShield,
  IconShieldPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';

import api from '@/api';

import PermissionPicker from './PermissionPicker';

interface RoleFormData {
  name: string;
  permissions: string[];
  dataScopes: string;
}

const INITIAL_FORM_DATA: RoleFormData = {
  name: '',
  permissions: [],
  dataScopes: '',
};

export default function RolesSection() {
  const queryClient = useQueryClient();

  const { data: roles, isLoading: isLoadingRoles } = api.useTeamRoles();

  const createRole = api.useCreateRole();
  const updateRole = api.useUpdateRole();
  const deleteRole = api.useDeleteRole();

  const [createEditModalOpen, setCreateEditModalOpen] = useState(false);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [formData, setFormData] = useState<RoleFormData>(INITIAL_FORM_DATA);

  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    id: string | null;
    name: string | null;
  }>({ id: null, name: null });

  const openCreateModal = () => {
    setEditingRoleId(null);
    setFormData(INITIAL_FORM_DATA);
    setCreateEditModalOpen(true);
  };

  const openEditModal = (role: {
    _id: string;
    name: string;
    permissions: string[];
    dataScopes?: string[];
  }) => {
    setEditingRoleId(role._id);
    setFormData({
      name: role.name,
      permissions: role.permissions ?? [],
      dataScopes: (role.dataScopes ?? []).join(', '),
    });
    setCreateEditModalOpen(true);
  };

  const closeCreateEditModal = () => {
    setCreateEditModalOpen(false);
    setEditingRoleId(null);
    setFormData(INITIAL_FORM_DATA);
  };

  const handleError = (e: unknown) => {
    if (e instanceof HTTPError) {
      e.response
        .json()
        .then(res => {
          notifications.show({
            color: 'red',
            message: res.message,
            autoClose: 5000,
          });
        })
        .catch(() => {
          notifications.show({
            color: 'red',
            message: 'Something went wrong. Please try again.',
            autoClose: 5000,
          });
        });
    } else {
      notifications.show({
        color: 'red',
        message: 'Something went wrong. Please try again.',
        autoClose: 5000,
      });
    }
  };

  const parseDataScopes = (input: string): string[] => {
    return input
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      return;
    }

    const payload = {
      name: formData.name.trim(),
      permissions: formData.permissions,
      dataScopes: parseDataScopes(formData.dataScopes),
    };

    if (editingRoleId) {
      updateRole.mutate(
        { id: editingRoleId, ...payload },
        {
          onSuccess: () => {
            notifications.show({
              color: 'green',
              message: 'Role updated successfully.',
            });
            queryClient.invalidateQueries({ queryKey: ['team/roles'] });
            closeCreateEditModal();
          },
          onError: handleError,
        },
      );
    } else {
      createRole.mutate(payload, {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Role created successfully.',
          });
          queryClient.invalidateQueries({ queryKey: ['team/roles'] });
          closeCreateEditModal();
        },
        onError: handleError,
      });
    }
  };

  const handleDelete = (id: string) => {
    deleteRole.mutate(
      { id },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Role deleted successfully.',
          });
          queryClient.invalidateQueries({ queryKey: ['team/roles'] });
          setDeleteConfirmation({ id: null, name: null });
        },
        onError: handleError,
      },
    );
  };

  const systemRoleEntries = Object.entries(SYSTEM_ROLES);

  return (
    <Box id="roles" data-testid="roles-section">
      <Text size="md">Roles</Text>
      <Divider my="md" />

      {/* System Roles */}
      <Card mb="md">
        <Card.Section withBorder py="sm" px="lg">
          <div className="fs-7">System Roles</div>
        </Card.Section>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Tbody>
              {systemRoleEntries.map(([key, role]) => (
                <Table.Tr key={key}>
                  <Table.Td>
                    <Group gap="xs">
                      <IconShield size={16} />
                      <span className="text-white fw-bold fs-7">
                        {role.name}
                      </span>
                      <Badge variant="light" color="gray" fw="normal" tt="none">
                        System
                      </Badge>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge variant="light" color="blue" fw="normal" tt="none">
                      {role.permissions.length} permissions
                    </Badge>
                  </Table.Td>
                  <Table.Td />
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card.Section>
      </Card>

      {/* Custom Roles */}
      <Card>
        <Card.Section withBorder py="sm" px="lg">
          <Group align="center" justify="space-between">
            <div className="fs-7">Custom Roles</div>
            <Button
              data-testid="new-role-button"
              variant="primary"
              leftSection={<IconShieldPlus size={16} />}
              onClick={openCreateModal}
            >
              New Custom Role
            </Button>
          </Group>
        </Card.Section>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Tbody>
              {!isLoadingRoles &&
                Array.isArray(roles?.data) &&
                roles.data.map((role: any) => (
                  <Table.Tr key={role._id}>
                    <Table.Td>
                      <Group gap="xs">
                        <IconShield size={16} />
                        <span className="text-white fw-bold fs-7">
                          {role.name}
                        </span>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="blue" fw="normal" tt="none">
                        {(role.permissions ?? []).length} permissions
                      </Badge>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Group justify="flex-end" gap="8">
                        <Button
                          size="compact-sm"
                          variant="danger"
                          leftSection={<IconTrash size={14} />}
                          onClick={() =>
                            setDeleteConfirmation({
                              id: role._id,
                              name: role.name,
                            })
                          }
                        >
                          Delete
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="secondary"
                          leftSection={<IconPencil size={14} />}
                          onClick={() => openEditModal(role)}
                        >
                          Edit
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              {!isLoadingRoles && (!roles?.data || roles.data.length === 0) && (
                <Table.Tr>
                  <Table.Td colSpan={3}>
                    <Text size="sm" c="dimmed" ta="center" py="md">
                      No custom roles yet. Create one to get started.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Card.Section>
      </Card>

      {/* Create / Edit Modal */}
      <Modal
        centered
        onClose={closeCreateEditModal}
        opened={createEditModalOpen}
        title={editingRoleId ? 'Edit Role' : 'New Custom Role'}
        size="lg"
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <Stack>
            <TextInput
              data-testid="role-name-input"
              label="Role Name"
              placeholder="e.g. Developer, Analyst"
              value={formData.name}
              onChange={e =>
                setFormData(prev => ({ ...prev, name: e.target.value }))
              }
              required
              withAsterisk={false}
            />
            <div>
              <Text size="sm" fw={500} mb={8}>
                Permissions
              </Text>
              <PermissionPicker
                value={formData.permissions}
                onChange={permissions =>
                  setFormData(prev => ({ ...prev, permissions }))
                }
              />
            </div>
            <TextInput
              data-testid="data-scopes-input"
              label="Data Scopes"
              description="Comma-separated list of data scope filters (e.g. service:api-auth, service:web)"
              placeholder="e.g. service:api-auth, service:web"
              value={formData.dataScopes}
              onChange={e =>
                setFormData(prev => ({ ...prev, dataScopes: e.target.value }))
              }
            />
            <Button
              data-testid="submit-role-button"
              variant="primary"
              type="submit"
              disabled={
                !formData.name.trim() ||
                formData.permissions.length === 0 ||
                createRole.isPending ||
                updateRole.isPending
              }
            >
              {editingRoleId ? 'Save Changes' : 'Create Role'}
            </Button>
          </Stack>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        centered
        onClose={() => setDeleteConfirmation({ id: null, name: null })}
        opened={deleteConfirmation.id != null}
        size="lg"
        title="Delete Role"
      >
        <Stack>
          <Text>
            Deleting the role &quot;{deleteConfirmation.name}&quot; will remove
            it and unassign any members currently assigned to this role. This
            action is not reversible.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button
              data-testid="cancel-delete-role"
              variant="secondary"
              onClick={() => setDeleteConfirmation({ id: null, name: null })}
            >
              Cancel
            </Button>
            <Button
              data-testid="confirm-delete-role"
              variant="danger"
              onClick={() =>
                deleteConfirmation.id && handleDelete(deleteConfirmation.id)
              }
            >
              Confirm
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Box>
  );
}
