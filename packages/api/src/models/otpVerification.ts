import crypto from 'crypto';
import mongoose, { Schema } from 'mongoose';

type ObjectId = mongoose.Types.ObjectId;

export type OtpType = 'login_2fa' | 'password_reset';

export interface IOtpVerification {
  _id: ObjectId;
  userId: ObjectId;
  type: OtpType;
  codeHash: string;
  magicTokenHash: string;
  attempts: number;
  lockedUntil: Date | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const OtpVerificationSchema = new Schema<IOtpVerification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['login_2fa', 'password_reset'],
      required: true,
    },
    codeHash: {
      type: String,
      required: true,
    },
    magicTokenHash: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

// TTL index — MongoDB auto-deletes expired records
OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// One active record per user+type
OtpVerificationSchema.index({ userId: 1, type: 1 }, { unique: true });

/**
 * Generate a 6-digit OTP code and a magic token.
 * Returns plaintext values (for email) and hashes (for storage).
 */
export function generateOtpPair(): {
  code: string;
  magicToken: string;
  codeHash: string;
  magicTokenHash: string;
} {
  const code = String(crypto.randomInt(100000, 999999));
  const magicToken = crypto.randomUUID();
  return {
    code,
    magicToken,
    codeHash: crypto.createHash('sha256').update(code).digest('hex'),
    magicTokenHash: crypto
      .createHash('sha256')
      .update(magicToken)
      .digest('hex'),
  };
}

/**
 * Hash a code or token for comparison against stored hash.
 */
export function hashOtp(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export default mongoose.model<IOtpVerification>(
  'OtpVerification',
  OtpVerificationSchema,
);
