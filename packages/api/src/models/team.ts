import { type Team } from '@hyperdx/common-utils/dist/types';
import mongoose, { Schema } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

type ObjectId = mongoose.Types.ObjectId;

export interface ITeam extends Team {
  _id: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type TeamDocument = mongoose.HydratedDocument<ITeam>;

export default mongoose.model<ITeam>(
  'Team',
  new Schema<ITeam>(
    {
      name: String,
      allowedAuthMethods: {
        type: [String],
        validate: {
          validator: (v: string[]) =>
            v.every(m => ['password', 'oidc'].includes(m)),
          message: 'allowedAuthMethods must be "password" or "oidc"',
        },
      },
      hookId: {
        type: String,
        default: function genUUID() {
          return uuidv4();
        },
      },
      apiKey: {
        type: String,
        default: function genUUID() {
          return uuidv4();
        },
      },
      collectorAuthenticationEnforced: {
        type: Boolean,
        default: false,
      },
      // TODO: maybe add these to a top level Mixed type
      // CH Client Settings
      metadataMaxRowsToRead: Number,
      searchRowLimit: Number,
      queryTimeout: Number,
      fieldMetadataDisabled: Boolean,
      parallelizeWhenPossible: Boolean,
      telegramConfig: {
        type: {
          botToken: { type: String },
          webhookUrl: { type: String },
          webhookSecret: { type: String },
        },
        required: false,
      },
    },
    {
      timestamps: true,
      toJSON: { virtuals: true },
      toObject: { virtuals: true },
    },
  ),
);
