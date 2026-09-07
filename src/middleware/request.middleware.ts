import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { getSettings } from '../services/settings.service';
import { ROLES } from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { logger } from '../config/logger';

/** Correlation id so a customer's error report can be traced in the logs. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && incoming.length <= 64
    ? incoming
    : crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

/** Lightweight access log. Bodies are never logged - they contain credentials. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`;
    if (res.statusCode >= 500) logger.error(line, { requestId: req.requestId });
    else if (res.statusCode >= 400) logger.warn(line, { requestId: req.requestId });
    else logger.debug(line, { requestId: req.requestId });
  });
  next();
}

/** Numeric comparison of `1.2.3` style versions. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Maintenance mode and minimum app version (spec section 32 settings).
 *
 * Admins are exempt from maintenance mode - otherwise turning it on would lock
 * out the very people who need to fix things. Reads are also allowed through so
 * a customer already in the app sees their orders rather than a blank screen;
 * only state-changing requests are blocked.
 */
export async function maintenanceGate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // Auth and settings must stay reachable, or the admin cannot sign in to
    // turn maintenance back off.
    if (req.path.includes('/auth/') || req.path.includes('/settings') || req.path === '/health') {
      return next();
    }

    const settings = await getSettings();

    const appVersion = req.headers['x-app-version'];
    if (
      settings.minSupportedAppVersion &&
      typeof appVersion === 'string' &&
      appVersion &&
      compareVersions(appVersion, settings.minSupportedAppVersion) < 0
    ) {
      return next(
        new ApiError(
          426,
          `Please update the app to continue. Version ${settings.minSupportedAppVersion} or newer is required.`,
          ERROR_CODES.APP_UPDATE_REQUIRED,
          { minSupportedAppVersion: settings.minSupportedAppVersion },
        ),
      );
    }

    if (!settings.maintenanceMode) return next();
    if (req.auth?.role === ROLES.ADMIN) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return next();

    return next(
      new ApiError(
        503,
        settings.maintenanceMessage ||
          'We are carrying out maintenance and will be back shortly. Thank you for your patience.',
        ERROR_CODES.MAINTENANCE,
      ),
    );
  } catch (err) {
    // A settings read failure must not take the whole API down.
    logger.warn('[maintenance] settings unavailable, allowing request', err);
    return next();
  }
}
