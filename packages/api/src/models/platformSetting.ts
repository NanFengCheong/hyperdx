import mongoose, { Document } from 'mongoose';

export interface IPlatformSetting extends Document {
  key: string;
  value: Record<string, unknown>;
  updatedBy: mongoose.Types.ObjectId;
}

const PlatformSettingSchema = new mongoose.Schema<IPlatformSetting>(
  {
    key: {
      type: String,
      required: true,
      unique: true,
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.model<IPlatformSetting>(
  'PlatformSetting',
  PlatformSettingSchema,
);
