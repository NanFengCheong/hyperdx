import mongoose, { Document } from 'mongoose';

export interface IRole extends Document {
  name: string;
  teamId: mongoose.Types.ObjectId | null;
  permissions: string[];
  dataScopes: string[];
  isSystem: boolean;
}

const RoleSchema = new mongoose.Schema<IRole>(
  {
    name: {
      type: String,
      required: true,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      default: null,
    },
    permissions: {
      type: [String],
      required: true,
      default: [],
    },
    dataScopes: {
      type: [String],
      default: [],
    },
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

RoleSchema.index({ teamId: 1, name: 1 }, { unique: true });

export default mongoose.model<IRole>('Role', RoleSchema);
