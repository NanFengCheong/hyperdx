import mongoose, { Schema } from 'mongoose';

type ObjectId = mongoose.Types.ObjectId;

export interface IGroup {
  _id: ObjectId;
  name: string;
  teamId: ObjectId;
  accountAccess: 'read-only' | 'read-write';
  dataScope: string;
  createdAt: Date;
  updatedAt: Date;
}

export type GroupDocument = mongoose.HydratedDocument<IGroup>;

const GroupSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    accountAccess: {
      type: String,
      enum: ['read-only', 'read-write'],
      default: 'read-only',
    },
    dataScope: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  },
);

// Compound index: group names are unique within a team
GroupSchema.index({ teamId: 1, name: 1 }, { unique: true });

export default mongoose.model<IGroup>('Group', GroupSchema);
