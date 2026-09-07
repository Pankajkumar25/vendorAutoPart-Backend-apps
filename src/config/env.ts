import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Every environment variable the server reads goes through this schema.
 * If a required secret is missing the process refuses to boot - that is far
 * safer than silently falling back to a default JWT secret in production.
 */
const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const int = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? defaultValue : Number(value)))
    .pipe(z.number().int());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(5000),
  API_PREFIX: z.string().default('/api/v1'),
  CORS_ORIGINS: z.string().default('*'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('30m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  BCRYPT_SALT_ROUNDS: int(12),

  OTP_LENGTH: int(6),
  OTP_TTL_MINUTES: int(10),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_DEBUG_RETURN: bool(false),

  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  CLOUDINARY_UPLOAD_FOLDER: z.string().default('autoparts/products'),

  // Image upload guard rails (used by the multer middleware).
  UPLOAD_MAX_FILE_SIZE_MB: int(5),
  UPLOAD_MAX_FILES: int(8),

  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  PAYMENT_CURRENCY: z.string().default('INR'),

  RATE_LIMIT_WINDOW_MINUTES: int(15),
  RATE_LIMIT_MAX: int(600),
  AUTH_RATE_LIMIT_MAX: int(20),

  SEED_ADMIN_NAME: z.string().default('Store Admin'),
  SEED_ADMIN_EMAIL: z.string().default('admin@autoparts.test'),
  SEED_ADMIN_MOBILE: z.string().default('9800000001'),
  SEED_ADMIN_PASSWORD: z.string().default('Admin@12345'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`\n[env] Invalid environment configuration:\n${issues}\n`);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDev = env.NODE_ENV === 'development';

export const corsOrigins: string[] | '*' =
  env.CORS_ORIGINS.trim() === '*' ? '*' : env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);

export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET,
);

export const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

/**
 * Guard rails: a production deploy must not run on the mock gateway or leak
 * OTPs through the API.
 */
if (isProd) {
  const fatal: string[] = [];
  if (env.PAYMENT_PROVIDER === 'mock') fatal.push('PAYMENT_PROVIDER must not be "mock" in production');
  if (env.PAYMENT_PROVIDER === 'razorpay' && !razorpayConfigured) fatal.push('Razorpay keys are missing');
  if (env.OTP_DEBUG_RETURN) fatal.push('OTP_DEBUG_RETURN must be false in production');
  if (corsOrigins === '*') fatal.push('CORS_ORIGINS must not be "*" in production');
  if (fatal.length) {
    // eslint-disable-next-line no-console
    console.error(`\n[env] Refusing to start in production:\n${fatal.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(1);
  }
}
