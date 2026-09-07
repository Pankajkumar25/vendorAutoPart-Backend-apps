import type { Request, Response } from 'express';
import { getSettings, updateSettings, invalidateSettingsCache } from '../../services/settings.service';
import { calculateDelivery } from '../../services/delivery.service';
import { evaluateCod, calculateCodAdvancePaise, codEvaluationToRupees } from '../../services/cod.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok } from '../../utils/apiResponse';
import { toPaise, toRupees, money } from '../../utils/money';

/**
 * Store settings administration (spec section 20, RULES 11, 12, 20).
 *
 * Every tunable business rule - COD ceiling, advance amount, GST mode, delivery
 * pricing - lives in one settings document and is edited here. The write goes
 * through `settings.service`, which refuses the immutable/audit fields and
 * invalidates the in-process cache so a change takes effect within seconds.
 */

/** Full settings document for the admin console (no secrets live here). */
export async function getStoreSettings(_req: Request, res: Response): Promise<void> {
  const settings = await getSettings(true); // force-read so the admin never sees a stale cached copy
  const obj = settings.toObject();
  delete (obj as Record<string, unknown>).__v;
  ok(res, obj);
}

export async function updateStoreSettings(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const settings = await updateSettings(req.body as Record<string, unknown>, String(actor.userId));
  const obj = settings.toObject();
  delete (obj as Record<string, unknown>).__v;
  ok(res, obj, 'Settings updated');
}

/** Manually clear the settings cache - a safety valve for the admin console. */
export async function refreshSettingsCache(_req: Request, res: Response): Promise<void> {
  invalidateSettingsCache();
  ok(res, { refreshed: true }, 'Settings cache cleared');
}

/**
 * Diagnostic (spec section 20): "for a ₹X, Y-kg order to this pincode, what
 * delivery charge and COD terms would a customer see?". Runs the exact same
 * delivery and COD engines the checkout uses, so the admin previews real
 * behaviour rather than an approximation.
 */
export async function checkServiceability(req: Request, res: Response): Promise<void> {
  const body = req.body as { pincode: string; amount?: number; weight?: number };
  const settings = await getSettings();

  const merchandisePaise = toPaise(body.amount ?? 0);
  const delivery = calculateDelivery(
    { merchandisePaise, totalWeightGrams: body.weight ?? 0, pincode: body.pincode },
    settings,
  );

  const grandTotalPaise = merchandisePaise + delivery.chargePaise;
  const cod = evaluateCod({ grandTotalPaise, hasCoupon: false }, settings);
  const advancePaise = calculateCodAdvancePaise(grandTotalPaise, settings);

  ok(res, {
    pincode: body.pincode,
    delivery: {
      charge: toRupees(delivery.chargePaise),
      isFree: delivery.isFree,
      reason: delivery.reason,
      estimatedDays: delivery.estimatedDays,
      freeDeliveryShortfall:
        delivery.freeDeliveryShortfallPaise != null ? toRupees(delivery.freeDeliveryShortfallPaise) : null,
    },
    order: {
      merchandise: money(body.amount ?? 0),
      grandTotal: toRupees(grandTotalPaise),
    },
    cod: {
      ...codEvaluationToRupees(cod),
      advanceForThisOrder: toRupees(advancePaise),
    },
  });
}
