import type { NextFunction, Request, Response } from 'express';
import { ROLES, type Permission } from '../config/constants';
import { ApiError } from '../utils/apiError';
import { logger } from '../config/logger';

/**
 * Admin authorisation (RULE 17: "admin permissions protected by backend
 * middleware").
 *
 * Hiding a button in the app is a UX decision. This is the actual boundary -
 * every admin route passes through it, so a customer's token calling an admin
 * endpoint directly with curl is refused here regardless of what the app shows.
 */

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(ApiError.unauthorized('Please sign in to continue'));

  if (req.auth.role !== ROLES.ADMIN) {
    logger.warn('[admin] non-admin attempted an admin route', {
      userId: String(req.auth.userId),
      path: req.originalUrl,
      method: req.method,
    });
    // 404-style vagueness is not used here: the caller is authenticated, so a
    // clear 403 is more useful than pretending the route does not exist.
    return next(ApiError.forbidden('Admin access is required for this action'));
  }

  return next();
}

/**
 * Requires one of the listed capabilities. A full admin (empty `permissions`)
 * passes everything; a restricted staff account must hold at least one of them.
 *
 * Read/write are separate permissions on purpose - `pricing.read` lets a staff
 * member audit what a customer is being charged without letting them change it.
 */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(ApiError.unauthorized('Please sign in to continue'));
    if (req.auth.role !== ROLES.ADMIN) {
      return next(ApiError.forbidden('Admin access is required for this action'));
    }
    if (req.auth.isFullAdmin) return next();

    const granted = permissions.some((p) => req.auth?.permissions.includes(p));
    if (!granted) {
      logger.warn('[admin] permission denied', {
        userId: String(req.auth.userId),
        required: permissions,
        held: req.auth.permissions,
        path: req.originalUrl,
      });
      return next(
        ApiError.forbidden(
          `You do not have permission to do this. Required: ${permissions.join(' or ')}.`,
          'PERMISSION_DENIED',
        ),
      );
    }
    return next();
  };
}

/**
 * Guards routes that expose another customer's data. A customer may only read
 * their own; an admin with the right permission may read anyone's.
 *
 * This is the middleware behind RULES 18/19 - customer-specific prices must
 * never leak to a different customer.
 */
export function requireSelfOrPermission(paramName: string, ...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(ApiError.unauthorized('Please sign in to continue'));

    const target = req.params[paramName];
    if (target && String(req.auth.userId) === target) return next();

    if (req.auth.role === ROLES.ADMIN) {
      if (req.auth.isFullAdmin || permissions.some((p) => req.auth?.permissions.includes(p))) {
        return next();
      }
    }

    return next(ApiError.forbidden('You can only access your own data'));
  };
}
