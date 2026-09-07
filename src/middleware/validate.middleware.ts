import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { ApiError } from '../utils/apiError';

/**
 * Zod request validation.
 *
 * Two things happen here that matter beyond rejecting bad input:
 *
 * 1. The parsed (coerced, stripped) result replaces the raw input, so handlers
 *    receive typed data and any field the schema does not declare is dropped.
 *    That is what stops a client from smuggling `{ price: 1 }` into a
 *    "add to cart" body and having some future handler read it.
 * 2. Errors come back field-keyed, which is exactly the shape React Hook Form
 *    needs to highlight the offending input.
 */

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function formatZodError(error: ZodError): { fields: Record<string, string>; message: string } {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    // Keep the first message per field - a list of five messages for one input
    // is noise in a mobile form.
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.values(fields)[0] ?? 'Please check the details you entered';
  return { fields, message: first };
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // Express 5 makes req.query a getter; assign the parsed object onto a
        // writable own property so handlers read the validated version.
        const parsed = schemas.query.parse(req.query);
        Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const { fields, message } = formatZodError(err);
        next(ApiError.validation(message, { fields }));
        return;
      }
      next(err);
    }
  };
}

/** Shorthand for the common body-only case. */
export const validateBody = (schema: ZodTypeAny) => validate({ body: schema });
export const validateQuery = (schema: ZodTypeAny) => validate({ query: schema });
export const validateParams = (schema: ZodTypeAny) => validate({ params: schema });
