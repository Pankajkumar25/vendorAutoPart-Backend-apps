import type { Request, Response } from 'express';
import * as cartService from '../services/cart.service';
import { tryEvaluateCoupon } from '../services/coupon.service';
import { requireAuth } from '../middleware/auth.middleware';
import { ok } from '../utils/apiResponse';
import { toPaise, toRupees } from '../utils/money';
import { PAYMENT_METHODS, type PaymentMethod } from '../config/constants';

/**
 * Cart (spec section 15).
 *
 * Requests carry product ids and quantities only. Nothing the client sends is
 * treated as a price: the response is always rebuilt by the pricing engine from
 * the customer's own rules (RULES 14, 15). That also means a cart left open for
 * a week silently picks up any price change the admin has made since.
 */

/** Reads the optional context that changes totals: payment method, coupon, PIN. */
function cartContext(req: Request) {
  const source = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
  return {
    paymentMethod: source.paymentMethod as PaymentMethod | undefined,
    pincode: typeof source.pincode === 'string' ? source.pincode : undefined,
  };
}

export async function getCart(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)));
}

export async function getCount(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  ok(res, { count: await cartService.getCartCount(auth.userId) });
}

export async function addItem(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.addToCart(auth.userId, req.body.productId, req.body.quantity ?? 1, 'increment');
  // The whole priced cart comes back so the client never has to recompute a
  // total after a mutation.
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)), 'Added to cart');
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.addToCart(auth.userId, req.params.productId, req.body.quantity, 'set');
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)), 'Cart updated');
}

export async function removeItem(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.removeFromCart(auth.userId, req.params.productId);
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)), 'Removed from cart');
}

export async function saveForLater(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.setSavedForLater(auth.userId, req.params.productId, true);
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)), 'Saved for later');
}

export async function moveToCart(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.setSavedForLater(auth.userId, req.params.productId, false);
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)), 'Moved to cart');
}

export async function clearCart(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.clearCart(auth.userId, req.query.includeSaved === 'true' || req.body?.includeSaved === true);
  ok(res, await cartService.getCartView(auth.userId, cartContext(req)), 'Cart cleared');
}

/**
 * Applies a coupon code.
 *
 * The code is stored on the cart and then evaluated by the pricing engine. If
 * it does not qualify - wrong payment method, below minimum, expired - the cart
 * comes back with `couponError` explaining why and the totals unchanged, rather
 * than a bare 4xx: the customer still needs to see their cart.
 */
export async function applyCoupon(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const code = String(req.body.code ?? '').trim().toUpperCase();

  await cartService.setCartCoupon(auth.userId, code);
  const view = await cartService.getCartView(auth.userId, { ...cartContext(req), couponCode: code });

  ok(
    res,
    view,
    view.pricing.summary.couponApplied
      ? `Coupon ${code} applied`
      : view.pricing.summary.couponFailure?.message ?? 'This coupon cannot be applied to your cart',
  );
}

export async function removeCoupon(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await cartService.setCartCoupon(auth.userId, null);
  ok(res, await cartService.getCartView(auth.userId, { ...cartContext(req), couponCode: null }), 'Coupon removed');
}

/**
 * Checks a code against the current cart without storing it - used by the
 * "have a coupon?" sheet so the customer can see the saving before committing.
 */
export async function previewCoupon(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const code = String(req.body.code ?? req.query.code ?? '').trim().toUpperCase();
  const context = cartContext(req);

  // Priced without any coupon, so the discount is measured against the same
  // subtotal the engine would use.
  const view = await cartService.getCartView(auth.userId, { ...context, couponCode: null });

  const { result, failure } = await tryEvaluateCoupon({
    code,
    userId: auth.userId,
    paymentMethod: context.paymentMethod ?? PAYMENT_METHODS.ONLINE,
    orderValuePaise: toPaise(view.pricing.summary.itemsSubtotal),
    lines: view.pricing.items.map((item) => ({
      productId: item.productId,
      categoryId: item.categoryId,
      linePaise: toPaise(item.lineSubtotal),
    })),
  });

  const discount = result ? toRupees(result.discountPaise) : 0;

  ok(res, {
    code,
    valid: Boolean(result),
    discount,
    reason: failure?.message ?? null,
    reasonCode: failure?.code ?? null,
    // Indicative only - GST and delivery are recomputed on the real quote, so
    // this is not treated as a total the customer can be charged.
    estimatedNewTotal: Math.max(0, view.pricing.summary.grandTotal - discount),
  });
}

/**
 * Drops dead lines and trims quantities to stock. The app calls this when a
 * checkout attempt failed on availability so the customer is not stuck.
 */
export async function reconcile(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const changes = await cartService.reconcileCart(auth.userId);
  const view = await cartService.getCartView(auth.userId, cartContext(req));
  ok(
    res,
    { ...view, changes },
    changes.removed.length || changes.adjusted.length
      ? 'Some items in your cart changed'
      : 'Your cart is up to date',
  );
}
