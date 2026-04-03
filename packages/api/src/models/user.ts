// @ts-ignore don't install the @types for this package, as it conflicts with mongoose
import passportLocalMongoose from '@hyperdx/passport-local-mongoose';
import mongoose, { Schema } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

type ObjectId = mongoose.Types.ObjectId;

export interface IUser {
  _id: ObjectId;
  accessKey: string;
  createdAt: Date;
  email: string;
  name: string;
  team: ObjectId;
  groupId?: ObjectId;
  roleId?: ObjectId;
  permissionOverrides?: {
    grants: string[];
    revokes: string[];
  };
  isSuperAdmin?: boolean;
  oidcSubject?: string;
  oidcProvider?: string;
  lastLoginAt?: Date;
  disabledAt?: Date | null;
  disabledReason?: string | null;
}

export type UserDocument = mongoose.HydratedDocument<IUser>;

const UserSchema = new Schema(
  {
    name: String,
    email: {
      type: String,
      required: true,
    },
    team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Group',
    },
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
    },
    permissionOverrides: {
      grants: { type: [String], default: [] },
      revokes: { type: [String], default: [] },
    },
    isSuperAdmin: {
      type: Boolean,
      default: false,
    },
    accessKey: {
      type: String,
      default: function genUUID() {
        return uuidv4();
      },
    },
    oidcSubject: {
      type: String,
      unique: true,
      sparse: true,
    },
    oidcProvider: {
      type: String,
    },
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
    disabledAt: {
      type: Date,
      default: null,
    },
    disabledReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

UserSchema.virtual('hasPasswordAuth').get(function (this: any) {
  // passport-local-mongoose sets 'hash' when a password is registered
  return !!(this.hash);
});

UserSchema.virtual('authMethod').get(function (this: any) {
  if (this.oidcProvider) {
    return this.hash ? 'oidc+password' : 'oidc';
  }
  return 'password';
});

UserSchema.plugin(passportLocalMongoose, {
  usernameField: 'email',
  usernameLowerCase: true,
  usernameCaseInsensitive: true,
});

UserSchema.index({ email: 1 }, { unique: true });

export default mongoose.model<IUser>('User', UserSchema);
