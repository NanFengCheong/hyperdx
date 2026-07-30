import type mongoose from 'mongoose';

import Role from '@/models/role';
import type { ITeamInvite } from '@/models/teamInvite';
import type { UserDocument } from '@/models/user';

export function findAssignableRole(
  teamId: string | mongoose.Types.ObjectId,
  roleId: string | mongoose.Types.ObjectId,
) {
  return Role.findOne({
    _id: roleId,
    name: { $ne: 'Super Admin' },
    $or: [{ teamId }, { teamId: null, isSystem: true }],
  });
}

export function findDefaultInviteRole() {
  return Role.findOne({ name: 'Viewer', isSystem: true });
}

export async function resolveInviteRole(invite: ITeamInvite) {
  if (invite.roleId) {
    const role = await findAssignableRole(invite.teamId, invite.roleId);
    if (role) return role;
  }

  return findDefaultInviteRole();
}

export async function applyInviteToUser(
  user: UserDocument,
  invite: ITeamInvite,
) {
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error('Invitation email does not match authenticated user');
  }

  const role = await resolveInviteRole(invite);
  if (!role) {
    throw new Error('Default invitation role is not configured');
  }

  user.team = invite.teamId;
  user.roleId = role._id;
  user.isSuperAdmin = invite.isSuperAdmin ?? false;
  await user.save();
}
