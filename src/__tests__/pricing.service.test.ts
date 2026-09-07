import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { calculateOrderPricing } from '../services/pricing.service';
import { Product } from '../models/product.model';
import { User } from '../models/user.model';
import { UserProductPrice } from '../models/userProductPrice.model';
import { QuantityDiscountRule } from '../models/quantityDiscountRule.model';
import { Coupon } from '../models/coupon.model';
import { COUPON_DISCOUNT_TYPE, PAYMENT_METHODS, RECORD_STATUS, ROLES } from '../config/constants';
import { ERROR_CODES } from '../utils/apiError';

/**
 * Pricing-engine acceptance tests.
 *
 * These are the business rules the whole project exists to guarantee, pinned to
 * the exact rupee figures from the spec's section 22 worked example. Money is
 * stored in rupees; the engine computes in paise; every number below is the
 * rupee value the customer, the invoice and the gateway must all agree on.
 *
 * Store settings are left at their defaults (GST EXCLUSIVE @ 18%, free delivery
 * over ₹3,000, SCOPE_OVERRIDE quantity resolution), which `getSettings()`
 * materialises automatically on first use.
 */

let seq = 0;

async function makeUser(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return User.create({
    name: `Test User ${seq}`,
    email: `user${seq}@test.local`,
    mobile: `98000000${String(seq).padStart(2, '0')}`,
    password: 'Passw0rd!',
    role: ROLES.USER,
    ...overrides,
  });
}

async function makeProduct(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return Product.create({
    name: `Test Part ${seq}`,
    slug: `test-part-${seq}`,
    sku: `SKU-${seq}`,
    partNumber: `PN-${seq}`,
    brand: 'TestBrand',
    category: new Types.ObjectId(),
    mrp: 1000,
    basePrice: 900,
    stock: 500,
    gstRate: 18,
    weight: 100,
    ...overrides,
  });
}

async function makeCoupon(overrides: Record<string, unknown> = {}) {
  return Coupon.create({
    code: 'SAVE6',
    title: 'Save 6%',
    discountType: COUPON_DISCOUNT_TYPE.PERCENTAGE,
    discountPercentage: 6,
    minOrderValue: 100,
    isActive: true,
    isPublic: true,
    ...overrides,
  });
}

describe('pricing engine', () => {
  // -------------------------------------------------------------------------
  // Section 22 worked example: base ₹900 x 6 = ₹5,400, then a 6% coupon.
  // -------------------------------------------------------------------------
  it('reproduces the section 22 worked example (₹5,400 → 6% coupon → ₹5,076 taxable)', async () => {
    const user = await makeUser();
    const product = await makeProduct({ basePrice: 900, mrp: 1000, gstRate: 18 });
    await makeCoupon();

    const result = await calculateOrderPricing({
      userId: user._id,
      items: [{ productId: String(product._id), quantity: 6 }],
      couponCode: 'SAVE6',
      paymentMethod: PAYMENT_METHODS.ONLINE,
    });

    // No quantity ladder exists, so gross and subtotal are the raw ₹5,400.
    expect(result.summary.itemsGross).toBe(5400);
    expect(result.summary.quantityDiscountTotal).toBe(0);

    // 6% of ₹5,400 = ₹324, applied because payment is ONLINE.
    expect(result.summary.couponApplied).toBe(true);
    expect(result.summary.couponDiscount).toBe(324);

    // Post-coupon, pre-tax taxable base, then GST @ 18% on top (EXCLUSIVE).
    expect(result.summary.taxableAmount).toBe(5076);
    expect(result.summary.gstTotal).toBe(913.68);
  });

  // -------------------------------------------------------------------------
  // RULE 7: only the single highest qualifying tier applies, never the sum.
  // -------------------------------------------------------------------------
  it('applies only the highest qualifying quantity tier (RULE 7), never the sum', async () => {
    const user = await makeUser();
    const product = await makeProduct({ basePrice: 900, mrp: 1000 });

    // Global ladder: 3+ → 2%, 6+ → 6%. At qty 6 the answer is 6%, not 8%.
    await QuantityDiscountRule.create({
      productId: null,
      categoryId: null,
      minimumQuantity: 3,
      discountPercentage: 2,
      status: RECORD_STATUS.ACTIVE,
    });
    await QuantityDiscountRule.create({
      productId: null,
      categoryId: null,
      minimumQuantity: 6,
      discountPercentage: 6,
      status: RECORD_STATUS.ACTIVE,
    });

    const result = await calculateOrderPricing({
      userId: user._id,
      items: [{ productId: String(product._id), quantity: 6 }],
      paymentMethod: PAYMENT_METHODS.ONLINE,
    });

    expect(result.items[0].quantityDiscount.percentage).toBe(6);
    // ₹5,400 × 6% = ₹324 (the summed 2%+6% = 8% would be ₹432).
    expect(result.summary.quantityDiscountTotal).toBe(324);
    expect(result.summary.itemsSubtotal).toBe(5076);
  });

  // -------------------------------------------------------------------------
  // RULE 18/19: two customers, same product, different prices - fully isolated.
  // -------------------------------------------------------------------------
  it('gives each customer their own price for the same product and never leaks another customer\'s (RULE 18/19)', async () => {
    const raj = await makeUser({ name: 'Raj Traders', businessName: 'Raj Traders' });
    const kumar = await makeUser({ name: 'Kumar Motors', businessName: 'Kumar Motors' });
    const product = await makeProduct({ basePrice: 1000, mrp: 1250 });

    await UserProductPrice.create({
      userId: raj._id,
      productId: product._id,
      customPrice: 900,
      status: RECORD_STATUS.ACTIVE,
    });
    await UserProductPrice.create({
      userId: kumar._id,
      productId: product._id,
      customPrice: 850,
      status: RECORD_STATUS.ACTIVE,
    });

    const forRaj = await calculateOrderPricing({
      userId: raj._id,
      items: [{ productId: String(product._id), quantity: 1 }],
    });
    const forKumar = await calculateOrderPricing({
      userId: kumar._id,
      items: [{ productId: String(product._id), quantity: 1 }],
    });

    // Each dealer sees only their own negotiated rate.
    expect(forRaj.items[0].hasCustomPrice).toBe(true);
    expect(forRaj.items[0].userPrice).toBe(900);
    expect(forRaj.items[0].effectiveUnitPrice).toBe(900);

    expect(forKumar.items[0].hasCustomPrice).toBe(true);
    expect(forKumar.items[0].userPrice).toBe(850);
    expect(forKumar.items[0].effectiveUnitPrice).toBe(850);

    // The two quotes are genuinely different, and Kumar's response carries no
    // trace of Raj's ₹900 price anywhere in its line pricing.
    expect(forKumar.items[0].effectiveUnitPrice).not.toBe(forRaj.items[0].effectiveUnitPrice);
    expect(forKumar.items[0].userPrice).not.toBe(900);
  });

  // -------------------------------------------------------------------------
  // RULE 9/10: coupons are ONLINE-only, rejected on COD - unconditionally.
  // -------------------------------------------------------------------------
  it('rejects coupons on COD but accepts the same coupon online (RULE 9/10)', async () => {
    const user = await makeUser();
    const product = await makeProduct({ basePrice: 900, mrp: 1000 });
    await makeCoupon();

    const cod = await calculateOrderPricing({
      userId: user._id,
      items: [{ productId: String(product._id), quantity: 6 }],
      couponCode: 'SAVE6',
      paymentMethod: PAYMENT_METHODS.COD,
    });

    expect(cod.summary.couponApplied).toBe(false);
    expect(cod.summary.couponDiscount).toBe(0);
    expect(cod.summary.couponFailure?.code).toBe(ERROR_CODES.COUPON_NOT_ALLOWED_FOR_COD);
    expect(cod.context.couponsAllowedForPaymentMethod).toBe(false);

    // Same coupon, same cart, ONLINE: now it applies. Proves the block is the
    // payment method, not the coupon.
    const online = await calculateOrderPricing({
      userId: user._id,
      items: [{ productId: String(product._id), quantity: 6 }],
      couponCode: 'SAVE6',
      paymentMethod: PAYMENT_METHODS.ONLINE,
    });
    expect(online.summary.couponApplied).toBe(true);
    expect(online.summary.couponDiscount).toBe(324);
    expect(online.context.couponsAllowedForPaymentMethod).toBe(true);
  });
});
