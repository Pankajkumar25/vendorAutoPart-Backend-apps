import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { ok, created } from '../utils/apiResponse';
import * as checkoutService from '../services/checkout.service';

/**
 * Payment-first checkout endpoints.
 *
 * POST /checkout/initiate — validates cart, reserves stock, creates Razorpay
 *   order (or marks COD). Does NOT create the real Order.
 *
 * POST /checkout/confirm — called after Razorpay payment (or immediately for
 *   COD). Creates the real Order and links the verified payment.
 */

export async function initiateCheckout(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const result = await checkoutService.initiateCheckout({
    userId: auth.userId,
    addressId: req.body.addressId,
    paymentMethod: req.body.paymentMethod,
    couponCode: req.body.couponCode,
    customerNote: req.body.customerNote,
    expectedTotal: req.body.expectedTotal,
  });

  created(res, result, 'Checkout initiated. Complete payment to place your order.');
}

export async function confirmCheckout(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const result = await checkoutService.confirmCheckout({
    userId: auth.userId,
    sessionId: req.body.sessionId,
    providerOrderId: req.body.providerOrderId,
    providerPaymentId: req.body.providerPaymentId,
    signature: req.body.signature,
  });

  const order = result.order;
  ok(
    res,
    {
      order: {
        id: String(order._id),
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        grandTotal: order.grandTotal,
      },
    },
    order.paymentStatus === 'PAID' ? 'Payment verified. Order confirmed!' : 'Order placed successfully.',
  );
}
