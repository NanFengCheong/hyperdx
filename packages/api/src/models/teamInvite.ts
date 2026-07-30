import mongoose, { Schema } from 'mongoose';
import ms from 'ms';

export interface ITeamInvite {
  createdAt: Date;
  email: string;
  isSuperAdmin?: boolean;
  name?: string;
  roleId?: mongoose.Types.ObjectId;
  teamId: mongoose.Types.ObjectId;
  token: string;
  updatedAt: Date;
}

const TeamInviteSchema = new Schema(
  {
    teamId: {
      type: Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    name: String,
    isSuperAdmin: {
      type: Boolean,
      default: false,
    },
    roleId: {
      type: Schema.Types.ObjectId,
      ref: 'Role',
    },
    email: {
      type: String,
      required: true,
    },
    token: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

TeamInviteSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: ms('30d') / 1000 },
);

TeamInviteSchema.index({ teamId: 1, email: 1 }, { unique: true });

export default mongoose.model<ITeamInvite>('TeamInvite', TeamInviteSchema);
