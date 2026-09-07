import { z } from 'zod';
import mongoose from 'mongoose';

/**
 * Building blocks shared by every validator.
 *
 * Domain rules live here rather than being retyped per route - an Indian mobile
 * number is the same shape whether it arrives at register, address or admin
 * user-create, and one definition means one place to change it.
 */

export const objectId = z
  .string()
  .trim()
  .refine((v) => mongoose.isValidObjectId(v), { message: 'Invalid id' });

export const objectIdParam = (name = 'id') => z.object({ [name]: objectId }).passthrough();

export const indianMobile = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');

export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);

/**
 * Password policy. Long enough to resist offline cracking, with a mixed-case +
 * digit requirement, but no punctuation mandate - that mostly drives people to
 * write passwords down.
 */
export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[a-z]/, 'Include at least one lowercase letter')
  .regex(/[A-Z]/, 'Include at least one uppercase letter')
  .regex(/\d/, 'Include at least one number');

export const pincode = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

export const gstNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]Z[A-Z\d]$/, 'Enter a valid 15-character GSTIN');

/** Rupee amount: non-negative, at most two decimals. */
export const rupees = z
  .number({ invalid_type_error: 'Enter a valid amount' })
  .min(0, 'Amount cannot be negative')
  .max(100_000_000, 'Amount is too large')
  .refine((v) => Number.isInteger(Math.round(v * 100)), { message: 'Amount can have at most 2 decimals' });

export const percentage = z
  .number({ invalid_type_error: 'Enter a valid percentage' })
  .min(0, 'Percentage cannot be negative')
  .max(100, 'Percentage cannot exceed 100');

export const quantity = z
  .number({ invalid_type_error: 'Enter a valid quantity' })
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(100_000, 'Quantity is too large');

/** Query-string number: arrives as a string, needs coercing. */
export const numericQuery = (min?: number, max?: number) => {
  let schema = z.coerce.number();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema.optional();
};

export const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'boolean') return v;
    return ['true', '1', 'yes'].includes(v);
  });

export const paginationQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  sort: z.string().trim().max(120).optional(),
});

export const dateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Trimmed, length-bounded free text. */
export const text = (max: number, label = 'This field') =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);

export const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''));

/** Comma-separated ids in a query string -> string[] */
export const idListQuery = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter((s) => mongoose.isValidObjectId(s))
      : undefined,
  );

export const stringArray = (max = 40, itemMax = 120) =>
  z.array(z.string().trim().min(1).max(itemMax)).max(max).optional();
