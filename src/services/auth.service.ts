import { Types } from 'mongoose';
import { User, type IUser } from '../models/user.model';
import { OtpToken, RefreshToken } from '../models/otp.model';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { OTP_PURPOSE, ROLES, USER_STATUS, type OtpPurpose, type Permission } from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import {
  durationToMs,
  hashToken,
  newTokenId,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/jwt';
import { generateOtp, hashOtp, newOtpReference, newSalt, otpExpiry, safeEqual } from '../utils/otp';
import crypto from 'crypto';

/**
 * Authentication (spec section 3).
 *
 * Three deliberate choices:
 *
 * - Login failures never say *which* half was wrong. "Invalid email or password"
 *   for both an unknown account and a bad password means the endpoint cannot be
 *   used to enumerate customers.
 * - Refresh tokens are stored hashed and rotated on every use. Presenting an
 *   already-exchanged token is treated as theft and kills the whole family of
 *   sessions for that user.
 * - The access token carries `tv` (tokenVersion). Disabling an account bumps
 *   that number, so access dies on the next request rather than at token expiry.
 */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface SessionMeta {
  device?: string;
  ip?: string;
}

export function publicUser(user: IUser) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    role: user.role,
    status: user.status,
    permissions: user.permissions ?? [],
    businessName: user.businessName ?? null,
    gstNumber: user.gstNumber ?? null,
    customerGroup: user.customerGroup ?? null,
    isFullAdmin: user.role === ROLES.ADMIN && (user.permissions?.length ?? 0) === 0,
    createdAt: user.createdAt,
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

// ---------------------------------------------------------------------------
// Token issuing
// ---------------------------------------------------------------------------

async function issueTokens(user: IUser, meta: SessionMeta = {}): Promise<AuthTokens> {
  const jti = newTokenId();

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role,
    permissions: user.role === ROLES.ADMIN ? (user.permissions as Permission[]) : undefined,
    tv: user.tokenVersion,
  });

  const refreshToken = signRefreshToken({ sub: String(user._id), jti });
  const refreshTtl = durationToMs(env.JWT_REFRESH_EXPIRES_IN);

  await RefreshToken.create({
    jti,
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    device: meta.device,
    ip: meta.ip,
    expiresAt: new Date(Date.now() + refreshTtl),
  });

  // Housekeeping: keep at most 10 live sessions per account so an old device
  // that never logged out cannot accumulate tokens indefinitely.
  const live = await RefreshToken.find({ userId: user._id, revokedAt: null })
    .sort({ createdAt: -1 })
    .skip(10)
    .select('_id')
    .lean();
  if (live.length) {
    await RefreshToken.updateMany(
      { _id: { $in: live.map((t) => t._id) } },
      { $set: { revokedAt: new Date() } },
    );
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: Math.floor(durationToMs(env.JWT_ACCESS_EXPIRES_IN) / 1000),
    refreshTokenExpiresIn: Math.floor(refreshTtl / 1000),
  };
}

// ---------------------------------------------------------------------------
// Register / login
// ---------------------------------------------------------------------------

export interface RegisterInput {
  name: string;
  email: string;
  mobile: string;
  password: string;
  businessName?: string;
  gstNumber?: string;
}

export async function register(
  input: RegisterInput,
  meta: SessionMeta = {},
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const email = input.email.trim().toLowerCase();

  const clash = await User.findOne({ $or: [{ email }, { mobile: input.mobile }] })
    .select('email mobile')
    .lean();
  if (clash) {
    throw new ApiError(
      409,
      clash.email === email
        ? 'An account with this email already exists. Please sign in instead.'
        : 'An account with this mobile number already exists. Please sign in instead.',
      ERROR_CODES.DUPLICATE_ENTRY,
      { field: clash.email === email ? 'email' : 'mobile' },
    );
  }

  let user: IUser;
  try {
    user = await User.create({
      name: input.name.trim(),
      email,
      mobile: input.mobile.trim(),
      password: input.password,
      businessName: input.businessName?.trim(),
      gstNumber: input.gstNumber?.trim().toUpperCase(),
      role: ROLES.USER,
      status: USER_STATUS.ACTIVE,
    });
  } catch (err) {
    // The unique indexes are the real guard; the pre-check above is only there
    // to produce a friendlier message in the common case.
    if ((err as { code?: number }).code === 11000) {
      throw new ApiError(409, 'An account with these details already exists', ERROR_CODES.DUPLICATE_ENTRY);
    }
    throw err;
  }

  const tokens = await issueTokens(user, meta);
  logger.info(`[auth] registered ${user.email}`);
  return { user: publicUser(user), tokens };
}

export async function login(
  identifier: string,
  password: string,
  meta: SessionMeta = {},
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const trimmed = identifier.trim().toLowerCase();

  // Customers sign in with either their email or their mobile number.
  const user = await User.findOne({
    $or: [{ email: trimmed }, { mobile: identifier.trim() }],
  }).select('+password');

  // Identical message and comparable work for both branches.
  const invalid = new ApiError(
    401,
    'Invalid email/mobile or password',
    ERROR_CODES.INVALID_CREDENTIALS,
  );

  if (!user) {
    // Burn a comparable amount of time so response timing does not reveal
    // whether the account exists.
    await new Promise((resolve) => setTimeout(resolve, 120));
    throw invalid;
  }

  const matches = await user.comparePassword(password);
  if (!matches) throw invalid;

  if (user.status === USER_STATUS.DISABLED) {
    throw new ApiError(
      403,
      'This account has been disabled. Please contact support for assistance.',
      ERROR_CODES.ACCOUNT_DISABLED,
    );
  }

  // Recorded with updateOne so the tokenVersion pre-save hook is not triggered.
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  const tokens = await issueTokens(user, meta);
  return { user: publicUser(user), tokens };
}

/** Admin sign-in. Same credentials check, but non-admins are turned away. */
export async function adminLogin(
  identifier: string,
  password: string,
  meta: SessionMeta = {},
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const result = await login(identifier, password, meta);
  if (result.user.role !== ROLES.ADMIN) {
    // Revoke the session we just created - it should never have been issued
    // through this door.
    await revokeAllSessions(new Types.ObjectId(result.user.id));
    throw ApiError.forbidden('This account does not have admin access');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Refresh / logout
// ---------------------------------------------------------------------------

export async function refreshSession(
  token: string,
  meta: SessionMeta = {},
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const payload = verifyRefreshToken(token);

  const record = await RefreshToken.findOne({ jti: payload.jti }).select('+tokenHash');
  if (!record) throw ApiError.sessionExpired('Your session is no longer valid. Please sign in again.');

  if (record.revokedAt) {
    // A revoked token being presented means either a stale client or a stolen
    // token. Either way, drop every session for that user and force a re-login.
    logger.warn(`[auth] reuse of revoked refresh token for user ${record.userId}`);
    await revokeAllSessions(record.userId);
    throw ApiError.sessionExpired('Your session was ended for security reasons. Please sign in again.');
  }

  if (!safeEqual(record.tokenHash, hashToken(token))) {
    await revokeAllSessions(record.userId);
    throw ApiError.sessionExpired('Your session is no longer valid. Please sign in again.');
  }

  const user = await User.findById(record.userId);
  if (!user) throw ApiError.unauthorized('Account not found');
  if (user.status === USER_STATUS.DISABLED) {
    await revokeAllSessions(user._id);
    throw new ApiError(403, 'This account has been disabled', ERROR_CODES.ACCOUNT_DISABLED);
  }

  const tokens = await issueTokens(user, meta);

  // Rotate: the presented token is spent and points at its replacement.
  record.revokedAt = new Date();
  record.replacedBy = verifyRefreshToken(tokens.refreshToken).jti;
  await record.save();

  return { user: publicUser(user), tokens };
}

export async function logout(refreshTokenValue?: string, userId?: Types.ObjectId): Promise<void> {
  if (refreshTokenValue) {
    try {
      const payload = verifyRefreshToken(refreshTokenValue);
      await RefreshToken.updateOne({ jti: payload.jti }, { $set: { revokedAt: new Date() } });
      return;
    } catch {
      // An expired or malformed token still means "log me out" - fall through.
    }
  }
  if (userId) await revokeAllSessions(userId);
}

export async function revokeAllSessions(userId: Types.ObjectId): Promise<number> {
  const res = await RefreshToken.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  return res.modifiedCount;
}

export async function listSessions(userId: Types.ObjectId) {
  const sessions = await RefreshToken.find({ userId, revokedAt: null })
    .sort({ createdAt: -1 })
    .select('jti device ip createdAt expiresAt')
    .lean();
  return sessions.map((s) => ({
    id: s.jti,
    device: s.device ?? 'Unknown device',
    ip: s.ip ?? null,
    signedInAt: s.createdAt,
    expiresAt: s.expiresAt,
  }));
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

export async function changePassword(
  userId: Types.ObjectId,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await User.findById(userId).select('+password');
  if (!user) throw ApiError.notFound('Account not found');

  if (!(await user.comparePassword(currentPassword))) {
    throw new ApiError(401, 'Your current password is incorrect', ERROR_CODES.INVALID_CREDENTIALS);
  }
  if (await user.comparePassword(newPassword)) {
    throw ApiError.badRequest('Your new password must be different from the current one');
  }

  user.password = newPassword; // hashed + tokenVersion bumped by pre-save hooks
  await user.save();

  // Changing a password ends every other session.
  await revokeAllSessions(user._id);
  logger.info(`[auth] password changed for ${user.email}`);
}

// ---------------------------------------------------------------------------
// OTP (registration verification / forgotten password)
// ---------------------------------------------------------------------------

export interface OtpChallenge {
  reference: string;
  identifier: string;
  expiresAt: Date;
  /** Present only when OTP_DEBUG_RETURN is on, which production config forbids. */
  debugCode?: string;
}

/**
 * Issues an OTP challenge.
 *
 * For FORGOT_PASSWORD the response is identical whether or not the account
 * exists - otherwise the endpoint becomes a customer-list oracle. When there is
 * no account we simply never store a challenge, and the later verify step fails
 * on a missing reference like any other wrong code.
 */
export async function requestOtp(params: {
  identifier: string;
  purpose: OtpPurpose;
}): Promise<OtpChallenge> {
  const identifier = params.identifier.trim().toLowerCase();

  const user = await User.findOne({
    $or: [{ email: identifier }, { mobile: params.identifier.trim() }],
  })
    .select('_id status')
    .lean();

  // Throttle: at most 3 challenges per identifier per 10 minutes.
  const recent = await OtpToken.countDocuments({
    identifier,
    purpose: params.purpose,
    createdAt: { $gt: new Date(Date.now() - 10 * 60_000) },
  });
  if (recent >= 3) {
    throw ApiError.tooMany('Too many verification codes requested. Please try again in a few minutes.');
  }

  const reference = newOtpReference();
  const expiresAt = otpExpiry();

  if (!user && params.purpose === OTP_PURPOSE.FORGOT_PASSWORD) {
    logger.info(`[auth] OTP requested for unknown identifier ${identifier} - responding generically`);
    return { reference, identifier, expiresAt };
  }
  if (user?.status === USER_STATUS.DISABLED) {
    throw new ApiError(403, 'This account has been disabled', ERROR_CODES.ACCOUNT_DISABLED);
  }

  const code = generateOtp();
  const salt = newSalt();

  await OtpToken.create({
    reference,
    purpose: params.purpose,
    identifier,
    userId: user?._id ?? null,
    codeHash: hashOtp(code, salt),
    salt,
    expiresAt,
  });

  // Delivery seam: wire an SMS/email provider here. Until then the code is
  // logged in development so the flow is testable end to end.
  logger.info(`[auth] OTP for ${identifier} (${params.purpose}): ${env.OTP_DEBUG_RETURN ? code : '******'}`);

  return {
    reference,
    identifier,
    expiresAt,
    ...(env.OTP_DEBUG_RETURN ? { debugCode: code } : {}),
  };
}

/**
 * Verifies a code and returns a short-lived proof token. The reset endpoint
 * takes that token rather than the OTP, so the code cannot be replayed.
 */
export async function verifyOtp(params: {
  reference: string;
  code: string;
}): Promise<{ verificationToken: string; identifier: string }> {
  const token = await OtpToken.findOne({ reference: params.reference }).select('+codeHash +salt');

  const invalid = new ApiError(
    400,
    'That code is incorrect or has expired. Please request a new one.',
    ERROR_CODES.OTP_INVALID,
  );

  if (!token || token.consumedAt || token.expiresAt.getTime() < Date.now()) throw invalid;

  if (token.attempts >= token.maxAttempts) {
    throw ApiError.tooMany('Too many incorrect attempts. Please request a new code.');
  }

  if (!safeEqual(token.codeHash, hashOtp(params.code.trim(), token.salt))) {
    token.attempts += 1;
    await token.save();
    throw invalid;
  }

  const verificationToken = crypto.randomBytes(32).toString('hex');
  token.consumedAt = new Date();
  token.verificationToken = hashToken(verificationToken);
  // Give the customer 15 minutes to actually set the new password.
  token.expiresAt = new Date(Date.now() + 15 * 60_000);
  await token.save();

  return { verificationToken, identifier: token.identifier };
}

export async function resetPasswordWithOtp(params: {
  reference: string;
  verificationToken: string;
  newPassword: string;
}): Promise<void> {
  const token = await OtpToken.findOne({
    reference: params.reference,
    purpose: OTP_PURPOSE.FORGOT_PASSWORD,
  }).select('+verificationToken');

  if (
    !token ||
    !token.consumedAt ||
    !token.verificationToken ||
    token.expiresAt.getTime() < Date.now() ||
    !safeEqual(token.verificationToken, hashToken(params.verificationToken))
  ) {
    throw new ApiError(
      400,
      'This password reset link is no longer valid. Please start again.',
      ERROR_CODES.OTP_INVALID,
    );
  }

  const user = token.userId
    ? await User.findById(token.userId).select('+password')
    : await User.findOne({ email: token.identifier }).select('+password');
  if (!user) throw ApiError.notFound('Account not found');

  user.password = params.newPassword;
  await user.save();

  // One-time use, and every existing session dies with the old password.
  token.verificationToken = null;
  token.expiresAt = new Date();
  await token.save();
  await revokeAllSessions(user._id);

  logger.info(`[auth] password reset completed for ${user.email}`);
}

// ---------------------------------------------------------------------------
// Push tokens
// ---------------------------------------------------------------------------

export async function registerPushToken(userId: Types.ObjectId, pushToken: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $addToSet: { pushTokens: pushToken } });
}

export async function removePushToken(userId: Types.ObjectId, pushToken: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $pull: { pushTokens: pushToken } });
}
