import { GST_MODE, type GstMode } from '../config/constants';
import { percentOfPaise, taxFromInclusivePaise } from '../utils/money';

/**
 * GST calculation. Two modes, both driven by settings so the store owner can
 * switch without a deploy:
 *
 *   EXCLUSIVE - listed prices are pre-tax; GST is added on top.
 *               taxable = line total, gst = taxable * rate/100
 *
 *   INCLUSIVE - listed prices already contain GST; the tax is only broken out
 *               for the invoice and does not change what the customer pays.
 *               gst = gross * rate / (100 + rate)
 *
 * Tax is computed per line, on the amount *after* both the quantity discount
 * and the customer's share of any coupon. Taxing a discounted sale at its
 * pre-discount value would over-collect GST.
 */

export interface LineTaxInput {
  /** Amount after quantity discount and coupon apportionment, in paise. */
  taxableBasePaise: number;
  gstRate: number;
}

export interface LineTaxResult {
  /** Net value the tax applies to, in paise. */
  taxablePaise: number;
  gstPaise: number;
  /** What this line contributes to the order total, in paise. */
  linePaise: number;
}

export function computeLineTax(input: LineTaxInput, mode: GstMode): LineTaxResult {
  const { taxableBasePaise, gstRate } = input;
  if (taxableBasePaise <= 0) return { taxablePaise: Math.max(0, taxableBasePaise), gstPaise: 0, linePaise: Math.max(0, taxableBasePaise) };

  if (mode === GST_MODE.INCLUSIVE) {
    const gstPaise = taxFromInclusivePaise(taxableBasePaise, gstRate);
    return {
      // Under inclusive pricing the net value is the gross minus the embedded tax.
      taxablePaise: taxableBasePaise - gstPaise,
      gstPaise,
      linePaise: taxableBasePaise,
    };
  }

  const gstPaise = percentOfPaise(taxableBasePaise, gstRate);
  return {
    taxablePaise: taxableBasePaise,
    gstPaise,
    linePaise: taxableBasePaise + gstPaise,
  };
}

/** Groups GST by rate for the invoice summary (e.g. "18% GST: ₹914.00"). */
export function summariseTaxByRate(
  lines: { gstRate: number; gstAmount: number; taxableAmount: number }[],
): { rate: number; taxableAmount: number; gstAmount: number }[] {
  const byRate = new Map<number, { rate: number; taxableAmount: number; gstAmount: number }>();
  for (const line of lines) {
    const bucket = byRate.get(line.gstRate) ?? { rate: line.gstRate, taxableAmount: 0, gstAmount: 0 };
    bucket.taxableAmount += line.taxableAmount;
    bucket.gstAmount += line.gstAmount;
    byRate.set(line.gstRate, bucket);
  }
  return [...byRate.values()]
    .filter((b) => b.gstAmount > 0)
    .map((b) => ({
      rate: b.rate,
      taxableAmount: Math.round(b.taxableAmount * 100) / 100,
      gstAmount: Math.round(b.gstAmount * 100) / 100,
    }))
    .sort((a, b) => a.rate - b.rate);
}
