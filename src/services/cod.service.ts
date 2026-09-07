import { COD_ADVANCE_MODE } from '../config/constants';
import type { ISettings } from '../models/settings.model';
import { ERROR_CODES } from '../utils/apiError';
import { percentOfPaise, toPaise, toRupees } from '../utils/money';

/**
 * COD eligibility and advance calculation (spec sections 18, 19, 23).
 *
 * Defaults, all admin-configurable:
 *   codMaxOrderAmount = ₹25,000  - ₹25,000 is allowed, ₹25,001 is not
 *   codAdvanceAmount  = ₹2,000   - paid online before the order is confirmed
 *
 * Nothing here is duplicated in the mobile app. The app calls the pricing
 * endpoint and renders whatever this returns, so raising the limit in the admin
 * panel takes effect immediately with no release.
 */

export interface CodEvaluationInput {
  /** Final order total, in paise. */
  grandTotalPaise: number;
  /** COD is never available alongside a coupon (RULE 9/10). */
  hasCoupon: boolean;
}

export interface CodEvaluation {
  available: boolean;
  /** Machine code the app switches on when COD is unavailable. */
  reasonCode: string | null;
  reason: string | null;
  maxOrderAmount: number;
  /** Advance that must be paid online, in paise. */
  advancePaise: number;
  /** Balance collected in cash on delivery, in paise. */
  remainingPaise: number;
  advanceRequired: boolean;
}

/**
 * Amount of online advance required for a COD order of this size.
 * Never exceeds the order total - a ₹500 order cannot demand a ₹2,000 advance.
 */
export function calculateCodAdvancePaise(grandTotalPaise: number, settings: ISettings): number {
  if (!settings.codAdvanceRequired) return 0;

  let advancePaise: number;
  if (settings.codAdvanceMode === COD_ADVANCE_MODE.PERCENTAGE) {
    advancePaise = percentOfPaise(grandTotalPaise, settings.codAdvancePercentage ?? 0);
    const floorPaise = toPaise(settings.codAdvanceMinAmount ?? 0);
    if (floorPaise > 0) advancePaise = Math.max(advancePaise, floorPaise);
    if (settings.codAdvanceMaxAmount != null) {
      advancePaise = Math.min(advancePaise, toPaise(settings.codAdvanceMaxAmount));
    }
  } else {
    advancePaise = toPaise(settings.codAdvanceAmount ?? 0);
  }

  return Math.max(0, Math.min(advancePaise, grandTotalPaise));
}

export function evaluateCod(input: CodEvaluationInput, settings: ISettings): CodEvaluation {
  const base = {
    maxOrderAmount: settings.codMaxOrderAmount,
    advanceRequired: settings.codAdvanceRequired,
  };

  if (!settings.codEnabled) {
    return {
      ...base,
      available: false,
      reasonCode: ERROR_CODES.COD_DISABLED,
      reason: 'Cash on delivery is currently unavailable',
      advancePaise: 0,
      remainingPaise: 0,
    };
  }

  if (input.hasCoupon) {
    return {
      ...base,
      available: false,
      reasonCode: ERROR_CODES.COUPON_NOT_ALLOWED_FOR_COD,
      reason: 'Remove the coupon to pay by cash on delivery',
      advancePaise: 0,
      remainingPaise: 0,
    };
  }

  const minPaise = toPaise(settings.codMinOrderAmount ?? 0);
  if (minPaise > 0 && input.grandTotalPaise < minPaise) {
    return {
      ...base,
      available: false,
      reasonCode: ERROR_CODES.COD_LIMIT_EXCEEDED,
      reason: `Cash on delivery needs a minimum order of ₹${settings.codMinOrderAmount.toLocaleString('en-IN')}`,
      advancePaise: 0,
      remainingPaise: 0,
    };
  }

  // Inclusive upper bound: ₹25,000 qualifies, ₹25,000.01 does not.
  const maxPaise = toPaise(settings.codMaxOrderAmount ?? 0);
  if (input.grandTotalPaise > maxPaise) {
    return {
      ...base,
      available: false,
      reasonCode: ERROR_CODES.COD_LIMIT_EXCEEDED,
      reason:
        `Cash on delivery is available on orders up to ₹${settings.codMaxOrderAmount.toLocaleString('en-IN')}. ` +
        `Please pay online for this order.`,
      advancePaise: 0,
      remainingPaise: 0,
    };
  }

  const advancePaise = calculateCodAdvancePaise(input.grandTotalPaise, settings);
  return {
    ...base,
    available: true,
    reasonCode: null,
    reason: null,
    advancePaise,
    remainingPaise: Math.max(0, input.grandTotalPaise - advancePaise),
  };
}

/** Rupee-shaped view of a COD evaluation for API responses. */
export function codEvaluationToRupees(evaluation: CodEvaluation) {
  return {
    available: evaluation.available,
    reasonCode: evaluation.reasonCode,
    reason: evaluation.reason,
    maxOrderAmount: evaluation.maxOrderAmount,
    advanceRequired: evaluation.advanceRequired,
    advanceAmount: toRupees(evaluation.advancePaise),
    remainingCodAmount: toRupees(evaluation.remainingPaise),
  };
}
