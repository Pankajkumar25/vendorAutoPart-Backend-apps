import { DELIVERY_MODE } from '../config/constants';
import type { ISettings } from '../models/settings.model';
import { toPaise } from '../utils/money';

/**
 * Delivery charge calculation (spec sections 21, 22 - "calculated according to
 * configured rules"). Everything here reads from settings; nothing is hard-coded.
 *
 * Modes:
 *   FREE       - never charge
 *   FLAT       - always `deliveryFlatCharge`, unless the free-above threshold
 *                is met
 *   FREE_ABOVE - `deliveryFlatCharge` below the threshold, free at or above it
 *   WEIGHT     - `deliveryPerKgCharge` per kg of total cart weight, clamped to
 *                the configured min/max, with the free-above threshold still
 *                honoured
 *
 * A matching pincode zone overrides the base mode entirely, which is how the
 * store handles "remote area surcharge" without new code.
 */

export interface DeliveryInput {
  /** Order value the free-shipping threshold is measured against, in paise. */
  merchandisePaise: number;
  /** Total cart weight in grams. */
  totalWeightGrams: number;
  pincode?: string | null;
}

export interface DeliveryResult {
  chargePaise: number;
  /** Which rule produced the number - surfaced in the checkout breakdown. */
  reason: string;
  isFree: boolean;
  estimatedDays: number;
  /** How much more the customer must add to qualify for free delivery. */
  freeDeliveryShortfallPaise: number | null;
}

function matchZone(settings: ISettings, pincode?: string | null) {
  if (!pincode || !settings.deliveryZones?.length) return null;
  // Longest matching prefix wins so `400001` prefers a `4000` zone over `4`.
  let best: { zone: ISettings['deliveryZones'][number]; length: number } | null = null;
  for (const zone of settings.deliveryZones) {
    for (const prefix of zone.pincodePrefixes ?? []) {
      if (prefix && pincode.startsWith(prefix) && (!best || prefix.length > best.length)) {
        best = { zone, length: prefix.length };
      }
    }
  }
  return best?.zone ?? null;
}

function clampCharge(settings: ISettings, chargePaise: number): number {
  const minPaise = toPaise(settings.deliveryMinCharge ?? 0);
  const maxPaise = settings.deliveryMaxCharge != null ? toPaise(settings.deliveryMaxCharge) : null;
  let out = Math.max(minPaise, chargePaise);
  if (maxPaise != null) out = Math.min(maxPaise, out);
  return Math.max(0, Math.round(out));
}

export function calculateDelivery(input: DeliveryInput, settings: ISettings): DeliveryResult {
  const estimatedDays = settings.estimatedDeliveryDays ?? 4;
  const zone = matchZone(settings, input.pincode);

  if (zone) {
    const zoneFreeAbovePaise =
      zone.freeAboveAmount != null ? toPaise(zone.freeAboveAmount) : null;
    if (zoneFreeAbovePaise != null && input.merchandisePaise >= zoneFreeAbovePaise) {
      return {
        chargePaise: 0,
        reason: `Free delivery in ${zone.label}`,
        isFree: true,
        estimatedDays: zone.estimatedDays ?? estimatedDays,
        freeDeliveryShortfallPaise: null,
      };
    }
    return {
      chargePaise: clampCharge(settings, toPaise(zone.charge)),
      reason: `Delivery charge for ${zone.label}`,
      isFree: false,
      estimatedDays: zone.estimatedDays ?? estimatedDays,
      freeDeliveryShortfallPaise:
        zoneFreeAbovePaise != null ? Math.max(0, zoneFreeAbovePaise - input.merchandisePaise) : null,
    };
  }

  const freeAbovePaise = toPaise(settings.deliveryFreeAboveAmount ?? 0);
  const qualifiesForFree = freeAbovePaise > 0 && input.merchandisePaise >= freeAbovePaise;
  const shortfall = freeAbovePaise > 0 ? Math.max(0, freeAbovePaise - input.merchandisePaise) : null;

  if (settings.deliveryMode === DELIVERY_MODE.FREE) {
    return {
      chargePaise: 0,
      reason: 'Free delivery on all orders',
      isFree: true,
      estimatedDays,
      freeDeliveryShortfallPaise: null,
    };
  }

  if (qualifiesForFree) {
    return {
      chargePaise: 0,
      reason: `Free delivery on orders above ₹${settings.deliveryFreeAboveAmount}`,
      isFree: true,
      estimatedDays,
      freeDeliveryShortfallPaise: null,
    };
  }

  if (settings.deliveryMode === DELIVERY_MODE.WEIGHT) {
    const kg = Math.max(0, input.totalWeightGrams) / 1000;
    // Bill part-kilos as whole kilos - couriers do the same.
    const billableKg = Math.max(1, Math.ceil(kg));
    const charge = clampCharge(settings, toPaise(settings.deliveryPerKgCharge) * billableKg);
    return {
      chargePaise: charge,
      reason: `Weight based delivery (${billableKg} kg)`,
      isFree: charge === 0,
      estimatedDays,
      freeDeliveryShortfallPaise: shortfall,
    };
  }

  // FLAT and FREE_ABOVE below the threshold behave identically.
  const charge = clampCharge(settings, toPaise(settings.deliveryFlatCharge));
  return {
    chargePaise: charge,
    reason: 'Standard delivery charge',
    isFree: charge === 0,
    estimatedDays,
    freeDeliveryShortfallPaise: shortfall,
  };
}
