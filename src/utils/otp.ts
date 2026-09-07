import crypto from 'crypto';
import { env } from '../config/env';

/**
 * Cryptographically random numeric OTP. `crypto.randomInt` is used rather than
 * `Math.random` because an OTP is a credential.
 */
export function generateOtp(length = env.OTP_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += crypto.randomInt(0, 10).toString();
  // Avoid an all-zero code, which looks broken to users.
  if (/^0+$/.test(out)) out = `${crypto.randomInt(1, 10)}${out.slice(1)}`;
  return out;
}

export function hashOtp(otp: string, salt: string): string {
  return crypto.createHmac('sha256', salt).update(otp).digest('hex');
}

export function newSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Timing-safe comparison so an attacker cannot learn the code byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Opaque handle returned to the client instead of the OTP itself. */
export function newOtpReference(): string {
  return crypto.randomBytes(20).toString('hex');
}

export function otpExpiry(minutes = env.OTP_TTL_MINUTES): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}
