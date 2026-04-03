import mongoose from 'mongoose';

import type { ObjectId } from '@/models';
import Alert from '@/models/alert';
import User from '@/models/user';
export function findUserByAccessKey(accessKey: string) {
  return User.findOne({ accessKey, disabledAt: null });
}

export function findUserById(id: string) {
  return User.findById(id).populate('groupId');
}

export function findUserByEmail(email: string) {
  // Case-insensitive email search - lowercase the email since User model stores emails in lowercase
  return User.findOne({ email: email.toLowerCase() });
}

export function findUsersByTeam(team: string | ObjectId) {
  return User.find({ team }).sort({ createdAt: 1 });
}

export async function reactivateTeamMember(
  teamId: string | ObjectId,
  userId: string,
): Promise<void> {
  const user = await User.findOne({ _id: userId, team: teamId });
  if (!user) {
    throw new Error('User not found in team');
  }
  if (user.disabledAt == null) {
    throw new Error('User is not disabled');
  }

  user.disabledAt = null;
  user.disabledReason = null;
  user.lastLoginAt = new Date();
  await user.save();
}

export async function deleteTeamMember(
  teamId: string | ObjectId,
  userIdToDelete: string,
  userIdRequestingDelete: string | ObjectId,
) {
  const [, deletedUser] = await Promise.all([
    Alert.updateMany(
      { createdBy: new mongoose.Types.ObjectId(userIdToDelete), team: teamId },
      {
        $set: {
          createdBy: new mongoose.Types.ObjectId(userIdRequestingDelete),
        },
      },
    ),
    User.findOneAndDelete({
      team: teamId,
      _id: userIdToDelete,
    }),
  ]);

  return deletedUser;
}
