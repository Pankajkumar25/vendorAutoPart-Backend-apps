import { Router } from 'express';
import * as c from '../controllers/auth.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { authLimiter, otpLimiter } from '../middleware/rateLimit.middleware';
import * as v from '../validators/auth.validator';

/**
 * Authentication (spec sections 4-7).
 *
 * The credential-bearing routes sit behind a strict rate limiter so a stolen
 * mobile number cannot be brute-forced, and the OTP routes behind an even
 * tighter one. Nothing here reads a role from the body - a token is minted by
 * the server and the role lives inside it (RULE 6).
 */
const router = Router();

router.post('/register', authLimiter, validateBody(v.registerSchema), asyncHandler(c.register));
router.post('/login', authLimiter, validateBody(v.loginSchema), asyncHandler(c.login));
router.post('/admin/login', authLimiter, validateBody(v.loginSchema), asyncHandler(c.adminLogin));

router.post('/refresh', validateBody(v.refreshSchema), asyncHandler(c.refresh));
router.post('/logout', optionalAuth, validateBody(v.logoutSchema), asyncHandler(c.logout));

router.post('/otp/request', otpLimiter, validateBody(v.requestOtpSchema), asyncHandler(c.requestOtp));
router.post('/otp/verify', otpLimiter, validateBody(v.verifyOtpSchema), asyncHandler(c.verifyOtp));
router.post('/password/reset', otpLimiter, validateBody(v.resetPasswordSchema), asyncHandler(c.resetPassword));

// Everything below needs a valid access token.
router.get('/sessions', authenticate, asyncHandler(c.sessions));
router.post('/change-password', authenticate, validateBody(v.changePasswordSchema), asyncHandler(c.changePassword));
router.post('/push-token', authenticate, validateBody(v.pushTokenSchema), asyncHandler(c.registerPushToken));
router.delete('/push-token', authenticate, validateBody(v.pushTokenSchema), asyncHandler(c.removePushToken));

export default router;
