import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/apiError';

/** Unknown route -> a JSON 404 in the same envelope as every other error. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Cannot ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

export default notFoundHandler;
