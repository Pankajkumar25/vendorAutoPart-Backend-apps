import crypto from 'crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import type { Permission, Role } from '../config/constants';
import { ApiError } from './apiError';

export interface AccessTokenPayload extends JwtPayload {
  sub: string;
  role: Role;
  permissions?: Permission[];
  /** Token version - bumped when an account is disabled or its role changes. */
  tv?: number;
  typ: 'access';
}

export interface RefreshTokenPayload extends JwtPayload {
  sub: string;
  /** Opaque id of the stored refresh-token record, so it can be revoked. */
  jti: string;
  typ: 'refresh';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'typ' | 'iat' | 'exp'>): string {
  const options: SignOptions = { expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign({ ...payload, typ: 'access' }, env.JWT_ACCESS_SECRET, options);
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, 'typ' | 'iat' | 'exp'>): string {
  const options: SignOptions = { expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign({ ...payload, typ: 'refresh' }, env.JWT_REFRESH_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    if (decoded.typ !== 'access') throw ApiError.unauthorized('Invalid token type');
    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw ApiError.sessionExpired();
    if (err instanceof ApiError) throw err;
    throw ApiError.unauthorized('Invalid or malformed token');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
    if (decoded.typ !== 'refresh') throw ApiError.unauthorized('Invalid token type');
    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw ApiError.sessionExpired();
    if (err instanceof ApiError) throw err;
    throw ApiError.unauthorized('Invalid or malformed refresh token');
  }
}

/** Refresh tokens are stored hashed, so a database dump cannot be replayed. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newTokenId(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** Turns `30d` / `12h` / `45m` / `90s` into milliseconds. */
export function durationToMs(duration: string): number {
  const match = /^(\d+)([smhd])$/.exec(duration.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return value * multipliers[unit];
}
