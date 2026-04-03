import { useState } from 'react';
import { HTTPError } from 'ky';
import CopyToClipboard from 'react-copy-to-clipboard';
import {
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconLock, IconUserPlus } from '@tabler/icons-react';

import api from '@/api';
import { useBrandDisplayName } from '@/theme/ThemeProvider';

function getDaysUntilDisable(lastLoginAt: string | undefined): number | null {
  if (!lastLoginAt) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceLogin = Math.floor(
    (Date.now() - new Date(lastLoginAt).getTime()) / msPerDay,
  );
  return Math.max(0, 90 - daysSinceLogin);
}

function getDaysLeftColor(daysLeft: number): string {
  if (daysLeft > 30) return 'green';
  if (daysLeft > 10) return 'yellow';
  return 'red';
}

export default function TeamMembersSection() {
  const brandName = useBrandDisplayName();
  const hasAdminAccess = true;

  const { data: team } = api.useTeam();
  const {
    data: members,
    isLoading: isLoadingMembers,
    refetch: refetchMembers,
  } = api.useTeamMembers();

  const {
    data: invitations,
    isLoading: isLoadingInvitations,
    refetch: refetchInvitations,
  } = api.useTeamInvitations();

  const onSubmitTeamInviteForm = ({ email }: { email: string }) => {
    sendTeamInviteAction(email);
    setTeamInviteModalShow(false);
  };

  const [
    deleteTeamMemberConfirmationModalData,
    setDeleteTeamMemberConfirmationModalData,
  ] = useState<{
    mode: 'team' | 'teamInvite' | null;
    id: string | null;
    email: string | null;
  }>({
    mode: null,
    id: null,
    email: null,
  });
  const [teamInviteModalShow, setTeamInviteModalShow] = useState(false);

  const { data: roles } = api.useTeamRoles();
  const assignRole = api.useAssignMemberRole();

  const roleOptions = [
    { value: '', label: 'No role' },
    ...(roles?.data ?? []).map((r: { _id: string; name: string }) => ({
      value: r._id,
      label: r.name,
    })),
  ];

  const saveTeamInvitation = api.useSaveTeamInvitation();
  const deleteTeamMember = api.useDeleteTeamMember();
  const deleteTeamInvitation = api.useDeleteTeamInvitation();
  const reactivateTeamMember = api.useReactivateTeamMember();

  const sendTeamInviteAction = (email: string) => {
    if (email) {
      saveTeamInvitation.mutate(
        { email },
        {
          onSuccess: () => {
            notifications.show({
              color: 'green',
              message:
                'Click "Copy URL" and share the URL with your team member',
            });
            refetchInvitations();
          },
          onError: e => {
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
                    message: `Something went wrong. Please contact ${brandName} team.`,

                    autoClose: 5000,
                  });
                });
            } else {
              notifications.show({
                color: 'red',
                message: `Something went wrong. Please contact ${brandName} team.`,
                autoClose: 5000,
              });
            }
          },
        },
      );
    }
  };

  const onConfirmDeleteTeamMember = (id: string) => {
    if (deleteTeamMemberConfirmationModalData.mode === 'team') {
      deleteTeamMemberAction(id);
    } else if (deleteTeamMemberConfirmationModalData.mode === 'teamInvite') {
      deleteTeamInviteAction(id);
    }
    setDeleteTeamMemberConfirmationModalData({
      mode: null,
      id: null,
      email: null,
    });
  };

  const deleteTeamInviteAction = (id: string) => {
    if (id) {
      deleteTeamInvitation.mutate(
        { id: encodeURIComponent(id) },
        {
          onSuccess: () => {
            notifications.show({
              color: 'green',
              message: 'Deleted team invite',
            });
            refetchInvitations();
          },
          onError: e => {
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
                    message: `Something went wrong. Please contact ${brandName} team.`,

                    autoClose: 5000,
                  });
                });
            } else {
              notifications.show({
                color: 'red',
                message: `Something went wrong. Please contact ${brandName} team.`,
                autoClose: 5000,
              });
            }
          },
        },
      );
    }
  };
  const deleteTeamMemberAction = (id: string) => {
    if (id) {
      deleteTeamMember.mutate(
        { userId: encodeURIComponent(id) },
        {
          onSuccess: () => {
            notifications.show({
              color: 'green',
              message: 'Deleted team member',
            });
            refetchMembers();
          },
          onError: e => {
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
                    message: `Something went wrong. Please contact ${brandName} team.`,
                    autoClose: 5000,
                  });
                });
            } else {
              notifications.show({
                color: 'red',
                message: `Something went wrong. Please contact ${brandName} team.`,
                autoClose: 5000,
              });
            }
          },
        },
      );
    }
  };

  return (
    <Box id="team_members" data-testid="team-members-section">
      <Text size="md">Team Members</Text>
      <Divider my="md" />
      <Card>
        <Card.Section withBorder py="sm" px="lg">
          <Group align="center" justify="space-between">
            <div className="fs-7">Team Members</div>
            <Button
              data-testid="invite-member-button"
              variant="primary"
              leftSection={<IconUserPlus size={16} />}
              onClick={() => setTeamInviteModalShow(true)}
            >
              Invite Team Member
            </Button>
          </Group>
        </Card.Section>
        <Card.Section>
          <Table horizontalSpacing="lg" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Member</Table.Th>
                <Table.Th>Inactivity Status</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th style={{ textAlign: 'right' }}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {!isLoadingMembers &&
                Array.isArray(members?.data) &&
                members?.data.map(member => (
                  <Table.Tr key={member.email}>
                    <Table.Td>
                      <div>
                        {member.isCurrentUser && (
                          <Badge variant="light" mr="xs" tt="none">
                            You
                          </Badge>
                        )}
                        <span className="text-white fw-bold fs-7">
                          {member.name}
                        </span>
                      </div>
                      <Group mt={4} fz="xs">
                        <div>{member.email}</div>
                        <div>
                          <IconLock size={14} />{' '}
                          {member.authMethod === 'oidc'
                            ? 'Microsoft Auth'
                            : member.authMethod === 'oidc+password'
                              ? 'Microsoft + Password Auth'
                              : 'Password Auth'}
                        </div>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {member.isSuperAdmin ? (
                        <Badge variant="light" color="blue" tt="none">
                          Exempt
                        </Badge>
                      ) : member.disabledAt ? (
                        <Group gap="xs">
                          <Badge variant="light" color="red" tt="none">
                            Disabled —{' '}
                            {new Date(member.disabledAt).toLocaleDateString()}
                          </Badge>
                          <Button
                            size="compact-xs"
                            variant="light"
                            color="green"
                            loading={reactivateTeamMember.isPending}
                            onClick={() =>
                              reactivateTeamMember.mutate(
                                { userId: member._id },
                                {
                                  onSuccess: () => {
                                    notifications.show({
                                      color: 'green',
                                      message: 'Team member reactivated',
                                    });
                                    refetchMembers();
                                  },
                                  onError: () => {
                                    notifications.show({
                                      color: 'red',
                                      message: `Failed to reactivate. Please contact ${brandName} team.`,
                                      autoClose: 5000,
                                    });
                                  },
                                },
                              )
                            }
                          >
                            Reactivate
                          </Button>
                        </Group>
                      ) : (
                        (() => {
                          const daysLeft = getDaysUntilDisable(
                            member.lastLoginAt,
                          );
                          return daysLeft != null ? (
                            <Badge
                              variant="light"
                              color={getDaysLeftColor(daysLeft)}
                              tt="none"
                            >
                              {daysLeft} days left
                            </Badge>
                          ) : (
                            <Badge variant="light" color="gray" tt="none">
                              No login recorded
                            </Badge>
                          );
                        })()
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={roleOptions}
                        value={member.roleId || ''}
                        onChange={value => {
                          assignRole.mutate(
                            { userId: member._id, roleId: value || null },
                            {
                              onSuccess: () => {
                                refetchMembers();
                                notifications.show({
                                  color: 'green',
                                  message: 'Role updated',
                                });
                              },
                              onError: e => {
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
                                        message: `Something went wrong. Please contact ${brandName} team.`,
                                        autoClose: 5000,
                                      });
                                    });
                                } else {
                                  notifications.show({
                                    color: 'red',
                                    message: `Something went wrong. Please contact ${brandName} team.`,
                                    autoClose: 5000,
                                  });
                                }
                              },
                            },
                          );
                        }}
                        placeholder="Assign role"
                        style={{ width: 160 }}
                      />
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      {!member.isCurrentUser && hasAdminAccess && (
                        <Group justify="flex-end" gap="8">
                          <Button
                            size="compact-sm"
                            variant="danger"
                            onClick={() =>
                              setDeleteTeamMemberConfirmationModalData({
                                mode: 'team',
                                id: member._id,
                                email: member.email,
                              })
                            }
                          >
                            Remove
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              {!isLoadingInvitations &&
                Array.isArray(invitations?.data) &&
                invitations.data.map(invitation => (
                  <Table.Tr key={invitation.email} className="mt-2">
                    <Table.Td>
                      <span className="text-white fw-bold fs-7">
                        {invitation.email}
                      </span>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="dot" color="gray" fw="normal" tt="none">
                        Pending Invite
                      </Badge>
                      <CopyToClipboard text={invitation.url}>
                        <Button size="compact-xs" variant="secondary" ml="xs">
                          📋 Copy URL
                        </Button>
                      </CopyToClipboard>
                    </Table.Td>
                    <Table.Td style={{ textAlign: 'right' }}>
                      {hasAdminAccess && (
                        <Group justify="flex-end" gap="8">
                          <Button
                            size="compact-sm"
                            variant="danger"
                            onClick={() =>
                              setDeleteTeamMemberConfirmationModalData({
                                mode: 'teamInvite',
                                id: invitation._id,
                                email: invitation.email,
                              })
                            }
                          >
                            Delete
                          </Button>
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
            </Table.Tbody>
          </Table>
        </Card.Section>
      </Card>

      <Modal
        centered
        onClose={() => setTeamInviteModalShow(false)}
        opened={teamInviteModalShow}
        title="Invite Team Member"
      >
        <InviteTeamMemberForm
          onSubmit={onSubmitTeamInviteForm}
          isSubmitting={saveTeamInvitation.isPending}
        />
      </Modal>

      <Modal
        centered
        onClose={() =>
          setDeleteTeamMemberConfirmationModalData({
            mode: null,
            id: null,
            email: null,
          })
        }
        opened={deleteTeamMemberConfirmationModalData.id != null}
        size="lg"
        title="Delete Team Member"
      >
        <Stack>
          <Text>
            Deleting this team member (
            {deleteTeamMemberConfirmationModalData.email}) will revoke their
            access to the team&apos;s resources and services. This action is not
            reversible.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button
              data-testid="cancel-delete-member"
              variant="secondary"
              onClick={() =>
                setDeleteTeamMemberConfirmationModalData({
                  mode: null,
                  id: null,
                  email: null,
                })
              }
            >
              Cancel
            </Button>
            <Button
              data-testid="confirm-delete-member"
              variant="danger"
              onClick={() =>
                deleteTeamMemberConfirmationModalData.id &&
                onConfirmDeleteTeamMember(
                  deleteTeamMemberConfirmationModalData.id,
                )
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

function InviteTeamMemberForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting?: boolean;
  onSubmit: (arg0: { email: string }) => void;
}) {
  const [email, setEmail] = useState<string>('');

  return (
    <form
      onSubmit={e => {
        onSubmit({ email });
        e.preventDefault();
      }}
    >
      <Stack>
        <TextInput
          data-testid="invite-email-input"
          label="Email"
          name="email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          placeholder="you@company.com"
          withAsterisk={false}
        />
        <div className="fs-8">
          The invite link will automatically expire after 30 days.
        </div>
        <Button
          data-testid="send-invite-button"
          variant="primary"
          type="submit"
          disabled={!email || isSubmitting}
        >
          Send Invite
        </Button>
      </Stack>
    </form>
  );
}
