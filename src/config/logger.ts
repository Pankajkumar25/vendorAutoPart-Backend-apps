import { env, isTest } from './env';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = env.NODE_ENV === 'development' ? 'debug' : 'info';

/**
 * Keys whose values must never reach the logs. Matched case-insensitively on a
 * substring basis so `razorpayKeySecret`, `password_hash` etc. are all caught.
 */
const REDACT_KEYS = [
  'password',
  'secret',
  'token',
  'authorization',
  'signature',
  'otp',
  'apikey',
  'api_key',
  'cardnumber',
  'cvv',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase();
    out[k] = REDACT_KEYS.some((needle) => lower.includes(needle)) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, args: unknown[]): void {
  if (isTest && level !== 'error') return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const stamp = new Date().toISOString();
  const safe = args.map((a) => (a instanceof Error ? a : redact(a)));
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`${stamp} ${level.toUpperCase().padEnd(5)}`, ...(safe as never[]));
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
