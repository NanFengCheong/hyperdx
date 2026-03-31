import { useState } from 'react';
import { HTTPError } from 'ky';
import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconFilter,
  IconLock,
  IconLockOpen,
  IconPencil,
  IconTrash,
  IconUsers,
  IconUsersPlus,
} from '@tabler/icons-react';

import api from '@/api';

interface GroupFormData {
  name: string;
  accountAccess: 'read-only' | 'read-write';
  dataScope: string;
}

const INITIAL_FORM_DATA: GroupFormData = {
  name: '',
  accountAccess: 'read-only',
  dataScope: '',
};

export default function GroupsSection() {
  const {
    data: groups,
    isLoading: isLoadingGroups,
    refetch: refetchGroups,
  } = api.useTeamGroups();

  const createGroup = api.useCreateGroup();
  const updateGroup = api.useUpdateGroup();
  const deleteGroup = api.useDeleteGroup();

  const [createEditModalOpen, setCreateEditModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [formData, setFormData] = useState<GroupFormData>(INITIAL_FORM_DATA);

  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    id: string | null;
    name: string | null;
  }>({ id: null, name: null });

  const openCreateModal = () => {
    setEditingGroupId(null);
    setFormData(INITIAL_FORM_DATA);
    setCreateEditModalOpen(true);
  };

  const openEditModal = (group: {
    _id: string;
    name: string;
    accountAccess: 'read-only' | 'read-write';
    dataScope?: string;
  }) => {
    setEditingGroupId(group._id);
    setFormData({
      name: group.name,
      accountAccess: group.accountAccess,
      dataScope: group.dataScope ?? '',
    });
    setCreateEditModalOpen(true);
  };

  const closeCreateEditModal = () => {
    setCreateEditModalOpen(false);
    setEditingGroupId(null);
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

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      return;
    }

    const payload = {
      name: formData.name.trim(),
      accountAccess: formData.accountAccess,
      dataScope: formData.dataScope.trim() || undefined,
    };

    if (editingGroupId) {
      updateGroup.mutate(
        { id: editingGroupId, ...payload },
        {
          onSuccess: () => {
            notifications.show({
              color: 'green',
              message: 'Group updated successfully.',
            });
            refetchGroups();
            closeCreateEditModal();
          },
          onError: handleError,
        },
      );
    } else {
      createGroup.mutate(payload, {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Group created successfully.',
          });
          refetchGroups();
          closeCreateEditModal();
        },
        onError: handleError,
      });
    }
  };

  const handleDelete = (id: string) => {
    deleteGroup.mutate(
      { id },
      {
        onSuccess: () => {
          notifications.show({
            color: 'green',
            message: 'Group deleted successfully.',
          });
          refetchGroups();
          setDeleteConfirmation({ id: null, name: null });
        },
        onError: handleError,
      },
    );
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <Box id="groups" data-testid="groups-section">
      <Text size="md">Groups</Text>
      <Divider my="md" />
      <Card>
        <Card.Section withBorder py="sm" px="lg">
          <Group align="center" justify="space-between">
            <div className="fs-7">Custom Groups</div>
            <Button
              data-testid="new-group-button"
              variant="primary"
              leftSection={<IconUsersPlus size={16} />}
              onClick={openCreateModal}
            >
              New Custom Group
            </Button>
          </Group>
        </Card.Section>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Tbody>
              {!isLoadingGroups &&
                Array.isArray(groups?.data) &&
                groups.data.map(group => (
                  <Table.Tr key={group._id}>
                    <Table.Td>
                      <Group gap="xs">
                        <IconUsers size={16} />
                        <span className="text-white fw-bold fs-7">
                          {group.name}
                        </span>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Badge
                          variant="light"
                          color={
                            group.accountAccess === 'read-write'
                              ? 'green'
                              : 'blue'
                          }
                          fw="normal"
                          tt="none"
                          leftSection={
                            group.accountAccess === 'read-write' ? (
                              <IconLockOpen size={12} />
                            ) : (
                              <IconLock size={12} />
                            )
                          }
                        >
                          {group.accountAccess === 'read-write'
                            ? 'Read and Write'
                            : 'Read-only'}
                        </Badge>
                        {group.dataScope && (
                          <Badge
                            variant="light"
                            color="violet"
                            fw="normal"
                            tt="none"
                            leftSection={<IconFilter size={12} />}
                          >
                            {group.dataScope}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {formatDate(group.updatedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      <Group justify="flex-end" gap="8">
                        <Button
                          size="compact-sm"
                          variant="danger"
                          leftSection={<IconTrash size={14} />}
                          onClick={() =>
                            setDeleteConfirmation({
                              id: group._id,
                              name: group.name,
                            })
                          }
                        >
                          Delete
                        </Button>
                        <Button
                          size="compact-sm"
                          variant="secondary"
                          leftSection={<IconPencil size={14} />}
                          onClick={() => openEditModal(group)}
                        >
                          Edit
                        </Button>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              {!isLoadingGroups &&
                (!groups?.data || groups.data.length === 0) && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No custom groups yet. Create one to get started.
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
        title={editingGroupId ? 'Edit Group' : 'New Custom Group'}
      >
        <form
          onSubmit={e => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <Stack>
            <TextInput
              data-testid="group-name-input"
              label="Group Name"
              placeholder="e.g. Engineering, Viewers"
              value={formData.name}
              onChange={e =>
                setFormData(prev => ({ ...prev, name: e.target.value }))
              }
              required
              withAsterisk={false}
            />
            <div>
              <Text size="sm" fw={500} mb={4}>
                Account Access
              </Text>
              <SegmentedControl
                data-testid="account-access-control"
                fullWidth
                value={formData.accountAccess}
                onChange={value =>
                  setFormData(prev => ({
                    ...prev,
                    accountAccess: value as 'read-only' | 'read-write',
                  }))
                }
                data={[
                  { label: 'Read-only', value: 'read-only' },
                  { label: 'Read and Write', value: 'read-write' },
                ]}
              />
            </div>
            <TextInput
              data-testid="data-scope-input"
              label="Data Scope"
              placeholder="e.g. service:api-auth"
              value={formData.dataScope}
              onChange={e =>
                setFormData(prev => ({ ...prev, dataScope: e.target.value }))
              }
            />
            <Button
              data-testid="submit-group-button"
              variant="primary"
              type="submit"
              disabled={
                !formData.name.trim() ||
                createGroup.isPending ||
                updateGroup.isPending
              }
            >
              {editingGroupId ? 'Save Changes' : 'Create Group'}
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
        title="Delete Group"
      >
        <Stack>
          <Text>
            Deleting the group &quot;{deleteConfirmation.name}&quot; will remove
            it and unassign any members currently in this group. This action is
            not reversible.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button
              data-testid="cancel-delete-group"
              variant="secondary"
              onClick={() => setDeleteConfirmation({ id: null, name: null })}
            >
              Cancel
            </Button>
            <Button
              data-testid="confirm-delete-group"
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
