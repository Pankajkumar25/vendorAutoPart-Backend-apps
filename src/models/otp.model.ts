import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { OTP_PURPOSE, type OtpPurpose } from '../config/constants';

/**
 * Short-lived OTP challenge. The code itself is never stored - only an HMAC of
 * it - so a database read cannot be used to complete somebody else's password
 * reset. Mongo's TTL monitor removes expired rows automatically.
 */
export interface IOtpToken extends Document {
  _id: Types.ObjectId;
  reference: string;
  purpose: OtpPurpose;
  /** Email or mobile the challenge was issued against. */
  identifier: string;
  userId?: Types.ObjectId | null;
  codeHash: string;
  salt: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: Date | null;
  /** Proof-of-OTP handed to the reset-password endpoint. */
  verificationToken?: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const otpTokenSchema = new Schema<IOtpToken>(
  {
    reference: { type: String, required: true, unique: true },
    purpose: { type: String, enum: Object.values(OTP_PURPOSE), required: true },
    identifier: { type: String, required: true, lowercase: true, trim: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    codeHash: { type: String, required: true, select: false },
    salt: { type: String, required: true, select: false },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    consumedAt: { type: Date, default: null },
    verificationToken: { type: String, default: null, select: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpTokenSchema.index({ identifier: 1, purpose: 1, createdAt: -1 });

export type IOtpTokenModel = Model<IOtpToken>;

export const OtpToken =
  (mongoose.models.OtpToken as IOtpTokenModel) ??
  mongoose.model<IOtpToken, IOtpTokenModel>('OtpToken', otpTokenSchema);

/**
 * Server-side refresh-token registry. Storing a hash of each issued token lets
 * logout genuinely revoke a session rather than relying on the client to
 * discard it.
 */
export interface IRefreshToken extends Document {
  _id: Types.ObjectId;
  jti: string;
  userId: Types.ObjectId;
  tokenHash: string;
  device?: string;
  ip?: string;
  revokedAt?: Date | null;
  /** Set when this token was exchanged, so reuse of an old token is detectable. */
  replacedBy?: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    jti: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, select: false },
    device: { type: String, trim: true, maxlength: 200 },
    ip: { type: String, trim: true, maxlength: 64 },
    revokedAt: { type: Date, default: null },
    replacedBy: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });

export type IRefreshTokenModel = Model<IRefreshToken>;

export const RefreshToken =
  (mongoose.models.RefreshToken as IRefreshTokenModel) ??
  mongoose.model<IRefreshToken, IRefreshTokenModel>('RefreshToken', refreshTokenSchema);
