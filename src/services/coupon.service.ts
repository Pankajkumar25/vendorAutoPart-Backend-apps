import { Types } from 'mongoose';
import { Coupon, CouponRedemption, type ICoupon } from '../models/coupon.model';
import {
  COUPON_DISCOUNT_TYPE,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { percentOfPaise, toPaise } from '../utils/money';

/**
 * Coupon validation and discount calculation (spec sections 16, 17).
 *
 * The rule that drives the design: RULE 9/10 - coupons work with ONLINE
 * payment only, never with COD. The mobile app hides the coupon field for COD,
 * but that is cosmetic. This service rejects a COD+coupon combination
 * unconditionally, so a hand-rolled API call gets the same answer as the app.
 */

export interface CouponEvaluationInput {
  code: string;
  userId: string | Types.ObjectId;
  paymentMethod: PaymentMethod;
  /** Order value the minimum-order rule is measured against, in paise. */
  orderValuePaise: number;
  /** Per-line context so product/category restrictions can be honoured. */
  lines: {
    productId: string;
    categoryId?: string | null;
    /** Line value after quantity discount, in paise. */
    linePaise: number;
  }[];
  now?: Date;
}

export interface CouponEvaluation {
  coupon: ICoupon;
  discountPaise: number;
  /** Line-value subset the discount was computed against, in paise. */
  eligiblePaise: number;
}

export interface CouponFailure {
  code: string;
  message: string;
}

/** Thrown for every rejection so the caller gets a stable machine code. */
function reject(code: string, message: string): never {
  throw new ApiError(422, message, code);
}

/**
 * Full validation. Throws ApiError with a domain code on any failure so the app
 * can render the right message ("Coupon expired", "Add ₹500 more", ...).
 */
export async function evaluateCoupon(input: CouponEvaluationInput): Promise<CouponEvaluation> {
  const now = input.now ?? new Date();
  const code = input.code.trim().toUpperCase();

  // RULE 10, enforced before anything else so the reason is unambiguous.
  if (input.paymentMethod === PAYMENT_METHODS.COD) {
    reject(
      ERROR_CODES.COUPON_NOT_ALLOWED_FOR_COD,
      'Coupons can only be used with online payment. Please switch to online payment to apply this coupon.',
    );
  }

  const coupon = await Coupon.findOne({ code });
  if (!coupon) reject(ERROR_CODES.COUPON_INVALID, 'This coupon code is not valid');
  if (!coupon.isActive) reject(ERROR_CODES.COUPON_INVALID, 'This coupon is no longer active');

  if (coupon.startDate && coupon.startDate.getTime() > now.getTime()) {
    reject(ERROR_CODES.COUPON_NOT_STARTED, 'This coupon is not active yet');
  }
  if (coupon.expiryDate && coupon.expiryDate.getTime() <= now.getTime()) {
    reject(ERROR_CODES.COUPON_EXPIRED, 'This coupon has expired');
  }

  // Private coupon: restricted to an explicit customer list.
  if (coupon.allowedUsers?.length) {
    const allowed = coupon.allowedUsers.some((id) => String(id) === String(input.userId));
    if (!allowed) reject(ERROR_CODES.COUPON_NOT_FOR_USER, 'This coupon is not available on your account');
  }

  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    reject(ERROR_CODES.COUPON_USAGE_EXCEEDED, 'This coupon has reached its usage limit');
  }

  if (coupon.perUserUsageLimit != null) {
    const used = await CouponRedemption.countDocuments({ couponId: coupon._id, userId: input.userId });
    if (used >= coupon.perUserUsageLimit) {
      reject(
        ERROR_CODES.COUPON_USER_LIMIT_EXCEEDED,
        coupon.perUserUsageLimit === 1
          ? 'You have already used this coupon'
          : `You can use this coupon only ${coupon.perUserUsageLimit} times`,
      );
    }
  }

  const minOrderPaise = toPaise(coupon.minOrderValue ?? 0);
  if (input.orderValuePaise < minOrderPaise) {
    const shortfall = (minOrderPaise - input.orderValuePaise) / 100;
    reject(
      ERROR_CODES.COUPON_MIN_ORDER,
      `Add ₹${shortfall.toLocaleString('en-IN', { maximumFractionDigits: 2 })} more to use this coupon ` +
        `(minimum order ₹${coupon.minOrderValue.toLocaleString('en-IN')})`,
    );
  }

  // Product / category restriction: the discount applies only to the matching
  // subset of lines, not the whole cart.
  const restrictedToProducts = coupon.applicableProducts?.length
    ? new Set(coupon.applicableProducts.map(String))
    : null;
  const restrictedToCategories = coupon.applicableCategories?.length
    ? new Set(coupon.applicableCategories.map(String))
    : null;

  let eligiblePaise = 0;
  if (!restrictedToProducts && !restrictedToCategories) {
    eligiblePaise = input.orderValuePaise;
  } else {
    for (const line of input.lines) {
      const productMatch = restrictedToProducts?.has(line.productId) ?? false;
      const categoryMatch = line.categoryId ? restrictedToCategories?.has(line.categoryId) ?? false : false;
      if (productMatch || categoryMatch) eligiblePaise += line.linePaise;
    }
    if (eligiblePaise <= 0) {
      reject(
        ERROR_CODES.COUPON_INVALID,
        'This coupon does not apply to any of the products in your cart',
      );
    }
  }

  let discountPaise: number;
  if (coupon.discountType === COUPON_DISCOUNT_TYPE.PERCENTAGE) {
    discountPaise = percentOfPaise(eligiblePaise, coupon.discountPercentage);
    if (coupon.maxDiscountAmount != null) {
      discountPaise = Math.min(discountPaise, toPaise(coupon.maxDiscountAmount));
    }
  } else {
    discountPaise = toPaise(coupon.discountAmount);
  }

  // A coupon can never make an order negative or free-plus-change.
  discountPaise = Math.max(0, Math.min(discountPaise, eligiblePaise));

  return { coupon, discountPaise, eligiblePaise };
}

/**
 * Non-throwing variant used by the cart/checkout preview: an invalid coupon
 * should not fail the whole price calculation, it should just come back as
 * "not applied, here's why".
 */
export async function tryEvaluateCoupon(
  input: CouponEvaluationInput,
): Promise<{ result: CouponEvaluation | null; failure: CouponFailure | null }> {
  try {
    const result = await evaluateCoupon(input);
    return { result, failure: null };
  } catch (err) {
    if (err instanceof ApiError) {
      return { result: null, failure: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

/**
 * Records a redemption once an order is actually confirmed.
 *
 * The unique (couponId, orderId) index makes this idempotent: a retried
 * payment-verification callback cannot inflate `usedCount`. The counter is only
 * incremented when the insert genuinely created a new row.
 */
export async function recordRedemption(params: {
  couponId: Types.ObjectId;
  code: string;
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  discountAmount: number;
}): Promise<boolean> {
  try {
    await CouponRedemption.create({
      couponId: params.couponId,
      code: params.code,
      userId: params.userId,
      orderId: params.orderId,
      discountAmount: params.discountAmount,
    });
  } catch (err) {
    // Duplicate key -> already recorded, nothing further to do.
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
  await Coupon.updateOne({ _id: params.couponId }, { $inc: { usedCount: 1 } });
  return true;
}

/** Releases a redemption when an order is cancelled before fulfilment. */
export async function releaseRedemption(orderId: Types.ObjectId): Promise<void> {
  const row = await CouponRedemption.findOneAndDelete({ orderId });
  if (row) await Coupon.updateOne({ _id: row.couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}

/**
 * Coupons this customer could plausibly use, for the "Offers" list. Only public
 * coupons and ones explicitly granted to them; a private coupon issued to a
 * different customer is never disclosed (RULE 18/19 in spirit).
 */
export async function listAvailableCoupons(userId: string | Types.ObjectId): Promise<ICoupon[]> {
  const now = new Date();
  const coupons = await Coupon.find({
    isActive: true,
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] },
      { $or: [{ isPublic: true, allowedUsers: { $size: 0 } }, { allowedUsers: userId }] },
    ],
  })
    .select('-createdBy')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

  // Drop globally exhausted coupons and ones this customer has used up.
  const usable: ICoupon[] = [];
  for (const coupon of coupons as unknown as ICoupon[]) {
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) continue;
    if (coupon.perUserUsageLimit != null) {
      // eslint-disable-next-line no-await-in-loop
      const used = await CouponRedemption.countDocuments({ couponId: coupon._id, userId });
      if (used >= coupon.perUserUsageLimit) continue;
    }
    usable.push(coupon);
  }
  return usable;
}
