import type { Request, Response } from 'express';
import * as authService from '../services/auth.service';
import { requireAuth } from '../middleware/auth.middleware';
import { created, ok } from '../utils/apiResponse';
import { OTP_PURPOSE } from '../config/constants';

/**
 * Auth endpoints (spec section 3).
 *
 * The controllers here are deliberately thin: every rule that matters - the
 * generic login failure, the rotating refresh token, the OTP throttle - lives in
 * the service, so the admin login route and the customer login route cannot
 * drift apart.
 */

function sessionMeta(req: Request): authService.SessionMeta {
  return {
    device: typeof req.body?.device === 'string' ? req.body.device : req.get('user-agent') ?? undefined,
    ip: req.ip,
  };
}

export async function register(req: Request, res: Response): Promise<void> {
  const result = await authService.register(
    {
      name: req.body.name,
      email: req.body.email,
      mobile: req.body.mobile,
      password: req.body.password,
      businessName: req.body.businessName || undefined,
      gstNumber: req.body.gstNumber || undefined,
    },
    sessionMeta(req),
  );
  created(res, result, 'Welcome aboard. Your account is ready.');
}

export async function login(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body.identifier, req.body.password, sessionMeta(req));
  ok(res, result, 'Signed in successfully');
}

/**
 * Separate door for the admin panel. It runs the same credential check and then
 * refuses non-admins, so a customer's password cannot be used to probe admin
 * endpoints even if the app bundle is decompiled.
 */
export async function adminLogin(req: Request, res: Response): Promise<void> {
  const result = await authService.adminLogin(req.body.identifier, req.body.password, sessionMeta(req));
  ok(res, result, 'Signed in successfully');
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const result = await authService.refreshSession(req.body.refreshToken, sessionMeta(req));
  ok(res, result);
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (req.body.allDevices) {
    const auth = requireAuth(req);
    const count = await authService.revokeAllSessions(auth.userId);
    ok(res, { revokedSessions: count }, 'Signed out of all devices');
    return;
  }
  // Single-device logout: revoke by refresh token. If the token is invalid or
  // expired the user is still signed out locally — the server call is best-effort.
  await authService.logout(req.body.refreshToken, req.auth?.userId);
  ok(res, { success: true }, 'Signed out');
}

export async function sessions(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  ok(res, await authService.listSessions(auth.userId));
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await authService.changePassword(auth.userId, req.body.currentPassword, req.body.newPassword);
  // Every session is invalidated by the tokenVersion bump, so the app has to
  // sign in again - which is the honest outcome of a password change.
  ok(res, { reauthenticationRequired: true }, 'Password updated. Please sign in again.');
}

export async function requestOtp(req: Request, res: Response): Promise<void> {
  const challenge = await authService.requestOtp({
    identifier: req.body.identifier,
    purpose: req.body.purpose ?? OTP_PURPOSE.FORGOT_PASSWORD,
  });

  ok(
    res,
    {
      reference: challenge.reference,
      identifier: challenge.identifier,
      expiresAt: challenge.expiresAt,
      // The service only populates this when OTP_DEBUG_RETURN is on, which the
      // production env schema forbids.
      ...(challenge.debugCode ? { debugCode: challenge.debugCode } : {}),
    },
    'We have sent you a verification code',
  );
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const result = await authService.verifyOtp({ reference: req.body.reference, code: req.body.code });
  ok(res, result, 'Code verified');
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  await authService.resetPasswordWithOtp({
    reference: req.body.reference,
    verificationToken: req.body.verificationToken,
    newPassword: req.body.newPassword,
  });
  ok(res, { success: true }, 'Password reset. Please sign in with your new password.');
}

export async function registerPushToken(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await authService.registerPushToken(auth.userId, req.body.pushToken);
  ok(res, { success: true });
}

export async function removePushToken(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await authService.removePushToken(auth.userId, req.body.pushToken);
  ok(res, { success: true });
}
