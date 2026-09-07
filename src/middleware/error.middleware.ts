import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { ApiError } from '../utils/apiError';
import { isProd } from '../config/env';
import { logger } from '../config/logger';

/**
 * Central error handler (spec section 45).
 *
 * The governing rule: a client learns what it needs to fix and nothing about
 * how the server is built. Mongoose messages, stack traces, driver error codes
 * and connection strings all stop here. Anything not deliberately thrown as an
 * ApiError is reported as a generic 500 and logged in full server-side.
 */

interface ErrorBody {
  success: false;
  message: string;
  code: string;
  details?: unknown;
  stack?: string;
}

/** Turns known third-party error shapes into ApiErrors. */
function normalise(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    return ApiError.validation(Object.values(fields)[0] ?? 'Validation failed', { fields });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const fields: Record<string, string> = {};
    for (const [path, detail] of Object.entries(err.errors)) {
      fields[path] = detail.message;
    }
    return ApiError.validation(Object.values(fields)[0] ?? 'Validation failed', { fields });
  }

  if (err instanceof mongoose.Error.CastError) {
    // "Cast to ObjectId failed for value ..." is meaningless to a customer.
    return ApiError.badRequest(
      err.path === '_id' ? 'That record could not be found' : `Invalid value for ${err.path}`,
      'INVALID_ID',
    );
  }

  // Duplicate key. Name the field, not the index.
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue ?? {};
    const field = Object.keys(keyValue)[0] ?? 'value';
    const pretty = field.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    return ApiError.conflict(`${pretty} is already in use`, 'DUPLICATE_ENTRY', { field });
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return ApiError.badRequest('The request body is not valid JSON', 'MALFORMED_JSON');
  }

  if ((err as { type?: string }).type === 'entity.too.large') {
    return new ApiError(413, 'That upload is too large', 'PAYLOAD_TOO_LARGE');
  }

  return ApiError.internal();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const apiError = normalise(err);
  const wasUnexpected = !(err instanceof ApiError);

  const logContext = {
    method: req.method,
    path: req.originalUrl,
    status: apiError.statusCode,
    code: apiError.code,
    userId: req.auth ? String(req.auth.userId) : undefined,
    requestId: req.requestId,
  };

  if (apiError.statusCode >= 500) {
    // Full detail server-side: this is the only place the real error survives.
    logger.error(`[error] ${apiError.message}`, { ...logContext, error: err });
  } else if (wasUnexpected || apiError.statusCode === 403) {
    logger.warn(`[error] ${apiError.message}`, logContext);
  } else {
    logger.debug(`[error] ${apiError.message}`, logContext);
  }

  const body: ErrorBody = {
    success: false,
    message: apiError.message,
    code: apiError.code,
  };

  if (apiError.details !== undefined) body.details = apiError.details;

  // Stacks are development-only, and only for genuine faults.
  if (!isProd && wasUnexpected && err instanceof Error) body.stack = err.stack;

  res.status(apiError.statusCode).json(body);
}

/**
 * Last-resort process handlers. An unhandled rejection leaves the process in an
 * unknown state, so it is logged and the process exits for the supervisor to
 * restart cleanly rather than limping on.
 */
export function installProcessHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    logger.error('[process] unhandled promise rejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('[process] uncaught exception - shutting down', error);
    process.exit(1);
  });
}
