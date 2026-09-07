import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Without this, an `await` that throws inside a route becomes an unhandled
 * rejection and the request hangs until the client times out.
 */
export const asyncHandler =
  <T extends Request = Request>(
    fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };

export default asyncHandler;
