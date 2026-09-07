import crypto from 'crypto';

/** `Brake Shoe / Pulsar 150` -> `brake-shoe-pulsar-150` */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

/**
 * Human-friendly, sortable, non-guessable order number:
 * `AP-250822-7F3K9Q`. The date prefix helps support staff; the random suffix
 * stops customers from enumerating other people's orders.
 */
export function generateOrderNumber(date = new Date()): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += alphabet[crypto.randomInt(0, alphabet.length)];
  return `AP-${yy}${mm}${dd}-${suffix}`;
}

/** Idempotency / receipt identifiers for the payment gateway. */
export function generateReceiptId(prefix = 'rcpt'): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive "contains" regex safe to interpolate from user input. */
export function containsRegex(term: string): RegExp {
  return new RegExp(escapeRegex(term.trim()), 'i');
}

/** Anchored prefix regex - index-friendly for autocomplete queries. */
export function prefixRegex(term: string): RegExp {
  return new RegExp(`^${escapeRegex(term.trim())}`, 'i');
}
