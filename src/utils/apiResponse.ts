import type { Response } from 'express';

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * Single response shape for the whole API so the mobile client only ever needs
 * one unwrapping path: `{ success, message, data, meta }`.
 */
export function ok<T>(
  res: Response,
  data: T,
  message?: string,
  meta?: Record<string, unknown>,
  statusCode = 200,
): Response {
  const body: ApiEnvelope<T> = { success: true, data };
  if (message) body.message = message;
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

export function created<T>(res: Response, data: T, message = 'Created successfully'): Response {
  return ok(res, data, message, undefined, 201);
}

export function paginated<T>(
  res: Response,
  items: T[],
  pagination: PaginationMeta,
  message?: string,
  extraMeta?: Record<string, unknown>,
): Response {
  return ok(res, items, message, { pagination, ...extraMeta });
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}
