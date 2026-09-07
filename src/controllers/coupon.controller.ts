import type { Request, Response } from 'express';
import { listAvailableCoupons, tryEvaluateCoupon } from '../services/coupon.service';
import { getCartView } from '../services/cart.service';
import { requireAuth } from '../middleware/auth.middleware';
import { ok } from '../utils/apiResponse';
import { toPaise, toRupees } from '../utils/money';
import { COUPON_DISCOUNT_TYPE, PAYMENT_METHODS, type PaymentMethod } from '../config/constants';

/**
 * Coupons, customer side (spec sections 16, 17).
 *
 * RULE 9/10 is enforced in `coupon.service`, not here - the app hides the coupon
 * field for COD as a courtesy, but a direct API call with COD gets the same
 * refusal.
 *
 * Private coupons issued to one dealer are never listed to another: the service
 * filters on `allowedUsers` containing the caller's own id.
 */

/** Public shape - `allowedUsers` and the audit fields never leave the server. */
function toPublicCoupon(coupon: Awaited<ReturnType<typeof listAvailableCoupons>>[number]) {
  const isPercentage = coupon.discountType === COUPON_DISCOUNT_TYPE.PERCENTAGE;
  return {
    id: String(coupon._id),
    code: coupon.code,
    title: coupon.title,
    description: coupon.description ?? null,
    discountType: coupon.discountType,
    discountPercentage: isPercentage ? coupon.discountPercentage : null,
    discountAmount: isPercentage ? null : coupon.discountAmount,
    maxDiscountAmount: coupon.maxDiscountAmount ?? null,
    minOrderValue: coupon.minOrderValue ?? 0,
    expiryDate: coupon.expiryDate ?? null,
    // Spelled out once here so every screen shows the same wording.
    terms: [
      `Valid on online payment only`,
      ...(coupon.minOrderValue ? [`Minimum order value ₹${coupon.minOrderValue.toLocaleString('en-IN')}`] : []),
      ...(isPercentage && coupon.maxDiscountAmount
        ? [`Maximum discount ₹${coupon.maxDiscountAmount.toLocaleString('en-IN')}`]
        : []),
      ...(coupon.perUserUsageLimit === 1 ? ['Can be used once per customer'] : []),
    ],
  };
}

export async function listCoupons(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const coupons = await listAvailableCoupons(auth.userId);
  ok(res, coupons.map(toPublicCoupon));
}

/**
 * Lists the same coupons, annotated with whether each one qualifies against the
 * cart as it stands - so the offers sheet can show "Add ₹500 more to use this"
 * instead of only failing after the customer taps Apply.
 */
export async function listApplicableCoupons(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const paymentMethod = ((req.query.paymentMethod as PaymentMethod | undefined) ?? PAYMENT_METHODS.ONLINE);

  const [coupons, view] = await Promise.all([
    listAvailableCoupons(auth.userId),
    getCartView(auth.userId, { paymentMethod, couponCode: null }),
  ]);

  const lines = view.pricing.items.map((item) => ({
    productId: item.productId,
    categoryId: item.categoryId,
    linePaise: toPaise(item.lineSubtotal),
  }));
  const orderValuePaise = toPaise(view.pricing.summary.itemsSubtotal);

  const evaluated = await Promise.all(
    coupons.map(async (coupon) => {
      const { result, failure } = await tryEvaluateCoupon({
        code: coupon.code,
        userId: auth.userId,
        paymentMethod,
        orderValuePaise,
        lines,
      });
      return {
        ...toPublicCoupon(coupon),
        eligible: Boolean(result),
        discount: result ? toRupees(result.discountPaise) : 0,
        reason: failure?.message ?? null,
        reasonCode: failure?.code ?? null,
      };
    }),
  );

  // Best saving first, then the ones the customer could unlock.
  evaluated.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.discount - a.discount);

  ok(res, evaluated, undefined, { cartSubtotal: view.pricing.summary.itemsSubtotal, paymentMethod });
}

/**
 * Validates a typed code against the live cart. Never applies it - `POST
 * /cart/coupon` does that - so the offers sheet can check a code without
 * mutating the cart.
 */
export async function validateCoupon(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const code = String(req.body.code ?? '').trim().toUpperCase();
  const paymentMethod = (req.body.paymentMethod as PaymentMethod | undefined) ?? PAYMENT_METHODS.ONLINE;

  const view = await getCartView(auth.userId, { paymentMethod, couponCode: null });

  const { result, failure } = await tryEvaluateCoupon({
    code,
    userId: auth.userId,
    paymentMethod,
    orderValuePaise: toPaise(view.pricing.summary.itemsSubtotal),
    lines: view.pricing.items.map((item) => ({
      productId: item.productId,
      categoryId: item.categoryId,
      linePaise: toPaise(item.lineSubtotal),
    })),
  });

  ok(res, {
    code,
    valid: Boolean(result),
    discount: result ? toRupees(result.discountPaise) : 0,
    reason: failure?.message ?? null,
    reasonCode: failure?.code ?? null,
  });
}
