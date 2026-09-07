/**
 * Every monetary computation in this codebase runs through these helpers.
 *
 * Rule: money is stored and transported as rupees (a Number with at most two
 * decimals) but *computed* in integer paise. Floating point rupee arithmetic
 * accumulates error - `0.1 + 0.2 !== 0.3` - and on an order with dozens of
 * lines that error becomes a visible one-rupee mismatch between the app, the
 * invoice and the payment gateway.
 */

/** Rupees -> integer paise. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  // Adding EPSILON compensates for values like 1000.005 that are stored
  // slightly below their decimal representation.
  return Math.round(rupees * 100 + Number.EPSILON * Math.sign(rupees));
}

/** Integer paise -> rupees rounded to 2 decimals. */
export function toRupees(paise: number): number {
  return Math.round(paise) / 100;
}

/** Rounds a rupee amount to 2 decimals. */
export function money(rupees: number): number {
  return toRupees(toPaise(rupees));
}

/**
 * Applies a percentage to a paise amount, rounding half-up to the nearest
 * paise. Used for discounts and tax so that the two never disagree.
 */
export function percentOfPaise(paise: number, percent: number): number {
  if (percent <= 0) return 0;
  return Math.round((paise * percent) / 100);
}

/**
 * Extracts the tax component already contained in a gross amount.
 * gross = net * (1 + r) => tax = gross * r / (1 + r)
 */
export function taxFromInclusivePaise(grossPaise: number, ratePercent: number): number {
  if (ratePercent <= 0) return 0;
  return Math.round((grossPaise * ratePercent) / (100 + ratePercent));
}

/**
 * Splits `totalPaise` across `weights` proportionally, guaranteeing the parts
 * sum *exactly* back to `totalPaise`. The largest-remainder method assigns the
 * leftover paise to the lines with the biggest fractional share, so a 100 paise
 * coupon over three equal lines becomes 34/33/33 rather than 33/33/33 with a
 * paise silently lost.
 */
export function distributeProportionally(totalPaise: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (totalPaise === 0) return new Array(n).fill(0);

  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) {
    // No meaningful weights - spread evenly and dump the remainder on line 0.
    const base = Math.floor(totalPaise / n);
    const parts = new Array(n).fill(base);
    parts[0] += totalPaise - base * n;
    return parts;
  }

  const exact = weights.map((w) => (totalPaise * w) / weightSum);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = totalPaise - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  for (let k = 0; remainder > 0 && k < order.length; k += 1, remainder -= 1) {
    floored[order[k].i] += 1;
  }
  // Guard against a pathological negative remainder.
  let idx = 0;
  while (remainder < 0 && idx < order.length) {
    const target = order[order.length - 1 - idx].i;
    if (floored[target] > 0) {
      floored[target] -= 1;
      remainder += 1;
    }
    idx += 1;
  }
  return floored;
}

/** Clamps a percentage into the 0-100 range. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** `1234.5` -> `"₹1,234.50"`. Server-side formatting for invoices/notifications. */
export function formatINR(rupees: number, opts: { decimals?: boolean } = {}): string {
  const value = money(rupees);
  const decimals = opts.decimals ?? !Number.isInteger(value);
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
