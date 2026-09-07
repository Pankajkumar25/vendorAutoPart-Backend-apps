import { z } from 'zod';
import { PAYMENT_METHODS } from '../config/constants';
import { objectId, optionalText, pincode, quantity } from './common.validator';

/**
 * Cart and checkout input.
 *
 * Note what is absent: no price, no discount, no total, no COD eligibility.
 * The client sends what the customer *wants* - product, quantity, coupon code,
 * payment method - and the server decides what it costs (RULES 14/15).
 */

export const addToCartSchema = z.object({
  productId: objectId,
  quantity: quantity.default(1),
  /** 'set' replaces the line quantity; 'increment' tops it up. */
  mode: z.enum(['increment', 'set']).default('increment'),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(0).max(100_000),
});

export const cartItemParams = z.object({ productId: objectId });

export const savedForLaterSchema = z.object({
  saved: z.boolean(),
});

export const cartQuery = z.object({
  paymentMethod: z.nativeEnum(PAYMENT_METHODS).optional(),
  couponCode: z.string().trim().max(40).optional(),
  pincode: pincode.optional(),
});

export const applyCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(2, 'Enter a coupon code')
    .max(40, 'That coupon code is too long'),
  paymentMethod: z.nativeEnum(PAYMENT_METHODS).optional(),
});

/**
 * Checkout preview. Returns the full server-computed breakdown for the chosen
 * payment method, including COD eligibility and the advance due.
 */
export const checkoutPreviewSchema = z.object({
  addressId: objectId.optional(),
  paymentMethod: z.nativeEnum(PAYMENT_METHODS).default(PAYMENT_METHODS.ONLINE),
  couponCode: z.string().trim().toUpperCase().max(40).optional().nullable(),
  items: z
    .array(z.object({ productId: objectId, quantity }))
    .max(200)
    .optional(),
});

export const createOrderSchema = z.object({
  addressId: objectId,
  paymentMethod: z.nativeEnum(PAYMENT_METHODS),
  couponCode: z.string().trim().toUpperCase().max(40).optional().nullable(),
  customerNote: optionalText(500),
  /**
   * The total the app displayed. Purely a tripwire: if it disagrees with the
   * server's own calculation the order is refused rather than silently charging
   * a different amount. It is never used *as* the price.
   */
  expectedTotal: z.number().min(0).optional(),
  items: z
    .array(z.object({ productId: objectId, quantity }))
    .max(200)
    .optional(),
});

export const verifyPaymentSchema = z.object({
  providerOrderId: z.string().trim().min(5).max(120),
  providerPaymentId: z.string().trim().min(5).max(120),
  signature: z.string().trim().min(20).max(256),
});

/** Dev-only simulator for the mock gateway. */
export const simulatePaymentSchema = z.object({
  providerOrderId: z.string().trim().min(5).max(120),
  outcome: z.enum(['success', 'failure']).default('success'),
});

export const cancelOrderSchema = z.object({
  reason: optionalText(300),
});
