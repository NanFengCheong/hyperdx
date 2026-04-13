import { useMemo, useState } from 'react';
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
  Pill,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconLock, IconUserPlus } from '@tabler/icons-react';

import api from '@/api';
import { usePermissions } from '@/contexts/PermissionContext';
import { useBrandDisplayName } from '@/theme/ThemeProvider';

function getDaysUntilDisable(
  lastLoginAt: string | undefined,
  now: number,
): number | null {
  if (!lastLoginAt) return null;
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceLogin = Math.floor(
    (now - new Date(lastLoginAt).getTime()) / msPerDay,
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
  const { can } = usePermissions();
  const canInvite = can('members:invite');
  const canRemove = can('members:remove');
  const canAssignGroup = can('members:assign-group');
  // eslint-disable-next-line no-restricted-syntax
  const now = useMemo(() => Date.now(), []);

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

  const onSubmitTeamInviteForm = ({ emails }: { emails: string[] }) => {
    for (const email of emails) {
      sendTeamInviteAction(email);
    }
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
            {canInvite ? (
              <Button
                data-testid="invite-member-button"
                variant="primary"
                leftSection={<IconUserPlus size={16} />}
                onClick={() => setTeamInviteModalShow(true)}
              >
                Invite Team Member
              </Button>
            ) : (
              <Tooltip label="You don't have permission to invite members">
                <Button
                  variant="primary"
                  leftSection={<IconUserPlus size={16} />}
                  disabled
                >
                  Invite Team Member
                </Button>
              </Tooltip>
            )}
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
                            variant="primary"
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
                      ) : getDaysUntilDisable(member.lastLoginAt, now) !=
                        null ? (
                        <Badge
                          variant="light"
                          color={getDaysLeftColor(
                            getDaysUntilDisable(member.lastLoginAt, now)!,
                          )}
                          tt="none"
                        >
                          {getDaysUntilDisable(member.lastLoginAt, now)} days
                          left
                        </Badge>
                      ) : (
                        <Badge variant="light" color="gray" tt="none">
                          No login recorded
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Select
                        size="xs"
                        data={roleOptions}
                        value={member.roleId || ''}
                        disabled={!canAssignGroup}
                        onChange={value => {
                          if (!canAssignGroup) return;
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
                      {!member.isCurrentUser && canRemove && (
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
                      {canInvite && (
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
        title="Invite Team Members"
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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ANGLE_BRACKET_EMAIL_REGEX = /<([^>]+)>/;

function parseEmails(input: string): string[] {
  const tokens = input.split(/[;,\n]+/);
  const emails: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    let email: string;
    const match = trimmed.match(ANGLE_BRACKET_EMAIL_REGEX);
    if (match) {
      email = match[1].trim().toLowerCase();
    } else {
      email = trimmed.toLowerCase();
    }

    if (email && !seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }

  return emails;
}

function InviteTeamMemberForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting?: boolean;
  onSubmit: (arg0: { emails: string[] }) => void;
}) {
  const [rawInput, setRawInput] = useState<string>('');

  const parsedEmails = useMemo(() => parseEmails(rawInput), [rawInput]);
  const validEmails = parsedEmails.filter(e => EMAIL_REGEX.test(e));
  const invalidEmails = parsedEmails.filter(e => !EMAIL_REGEX.test(e));

  return (
    <form
      onSubmit={e => {
        e.preventDefault();
        if (validEmails.length > 0) {
          onSubmit({ emails: validEmails });
        }
      }}
    >
      <Stack>
        <Textarea
          data-testid="invite-email-input"
          label="Email(s)"
          name="email"
          value={rawInput}
          onChange={e => setRawInput(e.target.value)}
          required
          placeholder={
            'you@company.com\nPaste multiple emails separated by , or ;\ne.g. Name <email@company.com>; Name <email@company.com>'
          }
          withAsterisk={false}
          minRows={3}
          autosize
          maxRows={8}
        />
        {parsedEmails.length > 0 && (
          <div>
            <Text size="xs" c="dimmed" mb={4}>
              {validEmails.length} email{validEmails.length !== 1 ? 's' : ''}{' '}
              detected
              {invalidEmails.length > 0 && ` (${invalidEmails.length} invalid)`}
            </Text>
            <Group gap={4} style={{ flexWrap: 'wrap' }}>
              {parsedEmails.map(email => (
                <Pill
                  key={email}
                  size="sm"
                  style={
                    !EMAIL_REGEX.test(email)
                      ? {
                          backgroundColor: 'var(--mantine-color-red-light)',
                          color: 'var(--mantine-color-red-text)',
                        }
                      : undefined
                  }
                >
                  {email}
                </Pill>
              ))}
            </Group>
          </div>
        )}
        <div className="fs-8">
          The invite link will automatically expire after 30 days.
        </div>
        <Button
          data-testid="send-invite-button"
          variant="primary"
          type="submit"
          disabled={validEmails.length === 0 || isSubmitting}
        >
          {validEmails.length > 1
            ? `Send ${validEmails.length} Invites`
            : 'Send Invite'}
        </Button>
      </Stack>
    </form>
  );
}
