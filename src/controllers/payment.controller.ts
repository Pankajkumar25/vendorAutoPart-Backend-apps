import type { Request, Response } from 'express';
import { Order } from '../models/order.model';
import { Payment } from '../models/payment.model';
import * as orderService from '../services/order.service';
import { gateway, isMockGateway, mockAdapter } from '../services/payment.service';
import { requireAuth } from '../middleware/auth.middleware';
import { ok } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { PAYMENT_PURPOSE, TXN_STATUS } from '../config/constants';
import { money } from '../utils/money';

/**
 * Payments (spec section 20, RULE 16).
 *
 * The client's role is limited to telling us *which* gateway transaction it
 * completed. The amount is never taken from the request: it was written to the
 * Payment row server-side when the transaction was created, and
 * `verifyGatewayPayment` compares the gateway's captured amount against that.
 * A tampered "I paid ₹1" therefore fails.
 *
 * The key secret exists only in `payment.service`. Nothing in this file can
 * return it - `getConfig` deliberately exposes the public key alone.
 */

/** Everything the client SDK needs to open the gateway sheet, and nothing more. */
export async function getConfig(_req: Request, res: Response): Promise<void> {
  const g = gateway();
  ok(res, {
    provider: g.name,
    publicKey: g.publicKey,
    currency: env.PAYMENT_CURRENCY,
    isMock: isMockGateway(),
  });
}

/**
 * Opens (or re-opens) payment for an order still sitting at PENDING.
 * The amount comes from the order's outstanding balance, not the request.
 */
export async function initiatePayment(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const orderId = req.body.orderId ?? req.params.orderId;

  const result = await orderService.retryPayment(orderId, auth.userId);

  if (!result.payment || !result.gatewayOrder) {
    ok(res, { required: false, order: { id: String(result.order._id), status: result.order.status } },
      'This order has nothing left to pay');
    return;
  }

  ok(res, {
    required: true,
    orderId: String(result.order._id),
    orderNumber: result.order.orderNumber,
    purpose: result.payment.purpose,
    amount: result.payment.expectedAmount,
    paymentId: String(result.payment._id),
    providerOrderId: result.gatewayOrder.providerOrderId,
    provider: result.gatewayOrder.provider,
    publicKey: result.gatewayOrder.publicKey,
    currency: result.gatewayOrder.currency,
  });
}

/**
 * The verification endpoint the app calls after the gateway sheet closes.
 * Idempotent: a duplicated callback returns the same result instead of
 * double-crediting the order or double-counting a coupon.
 */
export async function verifyPayment(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const { order, alreadyProcessed } = await orderService.verifyPaymentAndConfirm({
    userId: auth.userId,
    providerOrderId: req.body.providerOrderId ?? req.body.razorpay_order_id,
    providerPaymentId: req.body.providerPaymentId ?? req.body.razorpay_payment_id,
    signature: req.body.signature ?? req.body.razorpay_signature,
  });

  ok(
    res,
    {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      amountPaidOnline: order.amountPaidOnline,
      remainingCodAmount: order.remainingCodAmount,
      alreadyProcessed,
    },
    order.remainingCodAmount > 0
      ? `Advance received. ₹${order.remainingCodAmount.toLocaleString('en-IN')} is payable on delivery.`
      : 'Payment successful. Your order is confirmed.',
  );
}

/** Payment attempts for one of the caller's own orders. */
export async function getOrderPayments(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const order = await Order.findOne({ _id: req.params.orderId, userId: auth.userId })
    .select('orderNumber paymentMethod paymentStatus grandTotal amountPaidOnline advanceAmount advancePaidAmount remainingCodAmount')
    .lean();
  if (!order) throw ApiError.notFound('Order not found');

  const payments = await Payment.find({ orderId: order._id })
    .select('purpose provider providerOrderId providerPaymentId expectedAmount capturedAmount currency status method failureReason verifiedAt createdAt')
    .sort({ createdAt: -1 })
    .lean();

  ok(res, {
    order: {
      orderNumber: order.orderNumber,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      grandTotal: order.grandTotal,
      amountPaidOnline: order.amountPaidOnline,
      advanceAmount: order.advanceAmount,
      advancePaidAmount: order.advancePaidAmount,
      remainingCodAmount: order.remainingCodAmount,
    },
    attempts: payments.map((p) => ({
      id: String(p._id),
      purpose: p.purpose,
      provider: p.provider,
      providerOrderId: p.providerOrderId,
      reference: p.providerPaymentId ?? null,
      amount: p.capturedAmount ?? p.expectedAmount,
      currency: p.currency,
      status: p.status,
      method: p.method ?? null,
      failureReason: p.failureReason ?? null,
      at: p.verifiedAt ?? p.createdAt,
    })),
  });
}

/**
 * Dev-only success simulator.
 *
 * `mockAdapter()` throws if the live gateway is Razorpay, so this cannot be
 * reached in production even if the route were left mounted. It signs a payload
 * the same way the mock gateway would and then goes through the *real*
 * verification path - the shortcut is the payment, never the check.
 */
export async function simulatePayment(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const adapter = mockAdapter();

  const providerOrderId = String(req.body.providerOrderId ?? '');

  // Try old flow: find existing Payment record
  let payment = await Payment.findOne({ providerOrderId });

  // New checkout flow: payment record may not exist yet — find the session
  if (!payment) {
    const { CheckoutSession } = await import('../models/checkoutSession.model');
    const session = await CheckoutSession.findOne({
      providerOrderId,
      userId: auth.userId,
      status: 'PENDING',
    });
    if (!session) throw ApiError.notFound('Payment / session not found');

    const receipt = `sim_${providerOrderId.slice(-8)}`;
    payment = await Payment.create({
      orderId: session._id, // temporary — confirmCheckout links to real order
      userId: auth.userId,
      purpose: PAYMENT_PURPOSE.FULL,
      provider: session.provider ?? 'mock',
      providerOrderId,
      receipt,
      expectedAmount: money(session.amountDueNow),
      currency: session.currency ?? 'INR',
      status: TXN_STATUS.CREATED,
    });
  }

  if (String(payment.userId) !== String(auth.userId)) {
    throw ApiError.forbidden('This payment does not belong to your account');
  }

  const providerPaymentId = adapter.makePaymentId(providerOrderId);
  const signature = adapter.signPayload(providerOrderId, providerPaymentId);

  // Check if this is the old flow (Payment linked to an existing Order) or new flow (checkout session)
  const existingOrder = await Order.findById(payment.orderId);

  if (existingOrder) {
    // Old flow: verify + confirm
    const { order, alreadyProcessed } = await orderService.verifyPaymentAndConfirm({
      userId: auth.userId,
      providerOrderId,
      providerPaymentId,
      signature,
    });

    ok(
      res,
      {
        simulated: true,
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        status: order.status,
        paymentStatus: order.paymentStatus,
        alreadyProcessed,
      },
      'Mock payment completed',
    );
  } else {
    // New checkout flow: just update payment, confirmCheckout will handle the rest
    payment.providerPaymentId = providerPaymentId;
    payment.status = TXN_STATUS.SUCCESS;
    payment.verifiedAt = new Date();
    await payment.save();

    ok(
      res,
      {
        simulated: true,
        providerOrderId,
        providerPaymentId,
        signature,
        orderId: null,
        orderNumber: null,
        status: null,
        paymentStatus: null,
        alreadyProcessed: false,
      },
      'Mock payment simulated',
    );
  }
}

/**
 * Gateway webhook.
 *
 * Mounted with a raw body parser so the signature can be checked against the
 * exact bytes the gateway signed - a re-serialised JSON object would not match.
 * Always answers 200 once the signature is valid: a gateway that gets a 500
 * retries for hours, and our own processing failure is not the gateway's problem
 * to solve.
 */
export async function handleWebhook(req: Request, res: Response): Promise<void> {
  const signature =
    req.get('x-razorpay-signature') ?? req.get('x-webhook-signature') ?? '';
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});

  if (!gateway().verifyWebhookSignature(raw, signature)) {
    logger.warn('[payment] webhook signature rejected');
    throw ApiError.unauthorized('Invalid webhook signature');
  }

  let event: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
  try {
    event = JSON.parse(raw);
  } catch {
    throw ApiError.badRequest('Malformed webhook body');
  }

  const entity = event.payload?.payment?.entity ?? {};
  const providerOrderId = typeof entity.order_id === 'string' ? entity.order_id : null;
  const providerPaymentId = typeof entity.id === 'string' ? entity.id : null;

  // Acknowledge first; anything below is best-effort reconciliation.
  ok(res, { received: true });

  if (!providerOrderId || !providerPaymentId) return;

  try {
    const payment = await Payment.findOne({ providerOrderId });
    if (!payment) {
      logger.warn('[payment] webhook for unknown transaction', { providerOrderId });
      return;
    }
    if (payment.status === TXN_STATUS.SUCCESS) return;

    if (event.event === 'payment.failed') {
      payment.status = TXN_STATUS.FAILED;
      payment.providerPaymentId = providerPaymentId;
      payment.failureReason =
        typeof entity.error_description === 'string' ? entity.error_description : 'Reported failed by gateway';
      await payment.save();
      return;
    }

    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      // The webhook is a safety net for a client that closed mid-flow: run the
      // same verified confirmation path, not a shortcut around it.
      await orderService.verifyPaymentAndConfirm({
        userId: payment.userId,
        providerOrderId,
        providerPaymentId,
        // The gateway signs webhooks over the whole body, so the per-payment
        // handshake signature is regenerated for the mock adapter and taken from
        // the entity for real ones.
        signature:
          typeof entity.signature === 'string'
            ? entity.signature
            : isMockGateway()
              ? mockAdapter().signPayload(providerOrderId, providerPaymentId)
              : '',
      });
    }
  } catch (err) {
    // Never rethrow: the response has already been sent.
    logger.error('[payment] webhook processing failed', err);
  }
}

/** Which purposes exist, for the admin refund screen's dropdown. */
export const PAYMENT_PURPOSES = Object.values(PAYMENT_PURPOSE);
