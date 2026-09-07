import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { env, isTest } from '../config/env';
import { ERROR_CODES } from '../utils/apiError';

/**
 * Rate limiting (spec section 44).
 *
 * Tiered on purpose. A blanket limit strict enough to protect the login
 * endpoint would make ordinary catalogue browsing feel broken, and one loose
 * enough for browsing would leave login open to credential stuffing.
 *
 * Signed-in requests are keyed by user id rather than IP - a whole workshop
 * behind one NAT should not share a bucket.
 */

function keyGenerator(req: Request): string {
  if (req.auth) return `u:${String(req.auth.userId)}`;
  return `ip:${req.ip ?? 'unknown'}`;
}

function build(options: Partial<Options> & { max: number; windowMs: number; message: string }) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    // Tests would otherwise trip the limiter on their own fixtures.
    skip: () => isTest,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        message: options.message,
        code: ERROR_CODES.RATE_LIMITED,
      });
    },
    ...options,
    // Normalise our `max` shorthand onto express-rate-limit's `limit`, after the
    // spread so it always wins.
    limit: options.max,
  });
}

/** Broad limit applied to the whole API. */
export const generalLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60_000,
  max: env.RATE_LIMIT_MAX,
  message: 'Too many requests. Please slow down and try again shortly.',
});

/** Login / register / refresh. Deliberately tight. */
export const authLimiter = build({
  windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60_000,
  max: env.AUTH_RATE_LIMIT_MAX,
  message: 'Too many attempts. Please wait a few minutes before trying again.',
  // Successful sign-ins do not count, so a legitimate user who fat-fingers a
  // password twice and then gets in is not punished.
  skipSuccessfulRequests: true,
});

/** OTP requests cost money to send and are a spam vector. */
export const otpLimiter = build({
  windowMs: 10 * 60_000,
  max: 5,
  message: 'Too many verification codes requested. Please try again in a few minutes.',
});

/**
 * Payment endpoints. Not about abuse so much as preventing a retry storm from a
 * flaky mobile connection creating a pile of gateway orders.
 */
export const paymentLimiter = build({
  windowMs: 60_000,
  max: 12,
  message: 'Too many payment attempts. Please wait a moment and try again.',
});

/** Search: cheap per call, but typeahead fires on every keystroke. */
export const searchLimiter = build({
  windowMs: 60_000,
  max: 120,
  message: 'Too many searches. Please wait a moment.',
});

/** Image uploads. */
export const uploadLimiter = build({
  windowMs: 60_000,
  max: 30,
  message: 'Too many uploads. Please wait a moment.',
});

/** Order creation - a guard against accidental double submission at scale. */
export const orderLimiter = build({
  windowMs: 60_000,
  max: 10,
  message: 'Too many orders placed in a short time. Please wait a moment.',
});
