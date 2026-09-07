import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { ROLES, USER_STATUS, type Permission } from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { verifyAccessToken } from '../utils/jwt';
import type { AuthContext } from '../types/express';

/**
 * Authentication (spec sections 3, 35).
 *
 * The identity used by every downstream handler comes from a verified JWT and
 * nothing else. A request may claim `role: "ADMIN"` in its body all it likes -
 * that body is never read here.
 *
 * The token carries a `tv` (tokenVersion) claim. When an admin disables an
 * account or changes its role, the user document's tokenVersion is bumped, so
 * tokens minted before that change stop working on the next request instead of
 * lingering until they expire.
 */

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  // Fallback for the download/export links the admin panel opens directly.
  const queryToken = req.query.access_token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;
  return null;
}

async function resolveAuth(token: string): Promise<AuthContext> {
  const payload = verifyAccessToken(token);

  if (!payload.sub || !Types.ObjectId.isValid(payload.sub)) {
    throw ApiError.unauthorized('Invalid token subject');
  }

  // One lookup per request. It is what lets a disabled account be locked out
  // immediately, and it is a single indexed read on _id.
  const user = await User.findById(payload.sub)
    .select('role status permissions tokenVersion')
    .lean();

  if (!user) throw ApiError.unauthorized('Your account no longer exists');

  if (user.status === USER_STATUS.DISABLED) {
    throw new ApiError(
      403,
      'This account has been disabled. Please contact support.',
      ERROR_CODES.ACCOUNT_DISABLED,
    );
  }

  if ((payload.tv ?? 0) !== user.tokenVersion) {
    throw ApiError.sessionExpired('Your session is no longer valid. Please sign in again.');
  }

  const permissions = (user.permissions ?? []) as Permission[];

  return {
    userId: user._id,
    // The database is the authority on role, not the token.
    role: user.role,
    permissions,
    isFullAdmin: user.role === ROLES.ADMIN && permissions.length === 0,
    tokenVersion: user.tokenVersion,
  };
}

/** Rejects the request unless a valid access token is present. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) {
      throw ApiError.unauthorized('Please sign in to continue');
    }
    req.auth = await resolveAuth(token);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Attaches identity when a token is present but allows anonymous access.
 *
 * Used for browsing endpoints: a signed-out visitor sees default prices, a
 * signed-in customer sees their own negotiated prices, and the same route
 * serves both without duplicating the handler.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) return next();
  try {
    req.auth = await resolveAuth(token);
  } catch {
    // A bad or expired token on a public route is treated as "not signed in"
    // rather than an error, so browsing never hard-fails on a stale session.
  }
  return next();
}

/** Narrowing helper for handlers that run behind `authenticate`. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw ApiError.unauthorized('Please sign in to continue');
  return req.auth;
}
