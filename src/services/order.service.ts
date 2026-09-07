import mongoose, { Types } from 'mongoose';
import { Order, type IOrder, type IOrderAddress } from '../models/order.model';
import type { IOrderItem } from '../models/orderItem.model';
import { Product } from '../models/product.model';
import { Address, type IAddress } from '../models/address.model';
import { User } from '../models/user.model';
import { Payment, type IPayment } from '../models/payment.model';
import {
  ORDER_STATUS,
  ORDER_STATUS_FLOW,
  PAYMENT_METHODS,
  PAYMENT_PURPOSE,
  PAYMENT_STATUS,
  TXN_STATUS,
  USER_CANCELLABLE_STATUSES,
  type OrderStatus,
  type PaymentMethod,
} from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { generateOrderNumber, generateReceiptId } from '../utils/slug';
import { money, toPaise } from '../utils/money';
import { logger } from '../config/logger';
import { getSettings } from './settings.service';
import { assertQuotedTotalMatches, calculateOrderPricing, type OrderPricingResult } from './pricing.service';
import { gateway } from './payment.service';
import { recordRedemption, releaseRedemption } from './coupon.service';
import { clearCart } from './cart.service';
import * as notify from './notification.service';

/**
 * Order lifecycle (spec sections 19-24).
 *
 * Two things are worth calling out about the design:
 *
 * 1. PRICES ARE RECOMPUTED, NEVER ACCEPTED. `createOrder` ignores any amount in
 *    the request body and re-runs the pricing engine in strict mode. The client
 *    may optionally echo the total it displayed; if that disagrees with the
 *    server's figure we refuse the order instead of quietly charging a
 *    different amount (RULE 14/15).
 *
 * 2. NO ORDER IS CONFIRMED BEFORE ITS MONEY IS VERIFIED. An online order and a
 *    COD order both start at PENDING. Only a signature-verified,
 *    amount-matched gateway payment moves them to CONFIRMED. For COD that means
 *    a failed advance leaves the order PENDING - exactly as spec section 19
 *    requires.
 */

export interface CreateOrderInput {
  userId: string | Types.ObjectId;
  addressId: string;
  paymentMethod: PaymentMethod;
  couponCode?: string | null;
  customerNote?: string;
  /** Optional client-side total, used only as a mismatch tripwire. */
  expectedTotal?: number;
  /** Explicit item list; defaults to the customer's active cart. */
  items?: { productId: string; quantity: number }[];
}

export interface CreateOrderResult {
  order: IOrder;
  pricing: OrderPricingResult;
  /** Gateway handoff for the app, when a payment is due now. */
  payment: {
    required: boolean;
    purpose: string | null;
    amount: number;
    paymentId: string | null;
    providerOrderId: string | null;
    provider: string | null;
    publicKey: string | null;
    currency: string;
  };
}

// ---------------------------------------------------------------------------
// Stock reservation
// ---------------------------------------------------------------------------

/**
 * Reserves stock with a conditional decrement per product:
 * `{ _id, stock: { $gte: qty } }`. If the guard fails the row is untouched, so
 * two customers racing for the last unit cannot both succeed. Any partial
 * success is rolled back before the error propagates.
 */
async function reserveStock(
  items: { productId: string; quantity: number; name: string }[],
  session?: mongoose.ClientSession,
): Promise<void> {
  const reserved: { productId: string; quantity: number }[] = [];

  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const res = await Product.updateOne(
      { _id: item.productId, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } },
      session ? { session } : {},
    );

    if (res.modifiedCount !== 1) {
      // Roll back everything reserved so far.
      for (const done of reserved) {
        // eslint-disable-next-line no-await-in-loop
        await Product.updateOne(
          { _id: done.productId },
          { $inc: { stock: done.quantity } },
          session ? { session } : {},
        );
      }
      // eslint-disable-next-line no-await-in-loop
      const current = await Product.findById(item.productId).select('stock unit').lean();
      throw new ApiError(
        409,
        current && current.stock > 0
          ? `Only ${current.stock} ${current.unit ?? 'PCS'} of ${item.name} left. Please update the quantity.`
          : `${item.name} just went out of stock`,
        ERROR_CODES.INSUFFICIENT_STOCK,
        { productId: item.productId, availableStock: current?.stock ?? 0 },
      );
    }
    reserved.push({ productId: item.productId, quantity: item.quantity });
  }
}

/** Returns reserved stock to inventory. Guarded so it can only run once. */
async function restoreStock(order: IOrder): Promise<void> {
  if (order.stockRestored) return;
  const ops = order.items.map((item) => ({
    updateOne: { filter: { _id: item.productId }, update: { $inc: { stock: item.quantity } } },
  }));
  if (ops.length) await Product.bulkWrite(ops, { ordered: false });
  await Order.updateOne({ _id: order._id, stockRestored: false }, { $set: { stockRestored: true } });
  order.stockRestored = true;
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

function snapshotAddress(address: IAddress | null): IOrderAddress {
  if (!address) throw new ApiError(400, 'Please choose a delivery address', ERROR_CODES.ADDRESS_REQUIRED);
  return {
    addressId: address._id,
    fullName: address.fullName,
    mobile: address.mobile,
    alternateMobile: address.alternateMobile,
    houseNumber: address.houseNumber,
    street: address.street,
    area: address.area,
    landmark: address.landmark,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
    country: address.country,
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null,
    addressType: address.addressType,
  };
}

/** Maps a priced line onto the immutable order-item snapshot. */
function toOrderItem(line: OrderPricingResult['items'][number]): IOrderItem {
  return {
    productId: new Types.ObjectId(line.productId),
    name: line.name,
    sku: line.sku,
    partNumber: line.partNumber,
    brand: line.brand,
    image: line.image ?? undefined,
    categoryId: line.categoryId ? new Types.ObjectId(line.categoryId) : undefined,

    quantity: line.quantity,
    unit: line.unit,

    mrp: line.mrp,
    basePrice: line.basePrice,
    userPrice: line.userPrice,
    effectiveUnitPrice: line.effectiveUnitPrice,

    quantityDiscountScope: line.quantityDiscount.scope,
    quantityDiscountRuleId: line.quantityDiscount.ruleId
      ? new Types.ObjectId(line.quantityDiscount.ruleId)
      : null,
    quantityDiscountMinQty: line.quantityDiscount.minimumQuantity,
    quantityDiscountPercentage: line.quantityDiscount.percentage,
    quantityDiscountAmount: line.quantityDiscount.amount,

    grossAmount: line.grossAmount,
    lineSubtotal: line.lineSubtotal,
    couponDiscountShare: line.couponDiscountShare,
    taxableAmount: line.taxableAmount,
    gstRate: line.gstRate,
    gstAmount: line.gstAmount,
    lineTotal: line.lineTotal,
    weight: line.weight,
  };
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const settings = await getSettings();

  const address = await Address.findOne({
    _id: input.addressId,
    userId: input.userId,
    isDeleted: false,
  });
  if (!address) throw new ApiError(404, 'Delivery address not found', ERROR_CODES.ADDRESS_REQUIRED);

  // Item source: explicit list, else the customer's active cart.
  let items = input.items;
  if (!items?.length) {
    const { Cart } = await import('../models/cart.model');
    const cart = await Cart.findOne({ userId: input.userId }).lean();
    items = (cart?.items ?? [])
      .filter((i) => !i.savedForLater)
      .map((i) => ({ productId: String(i.productId), quantity: i.quantity }));
  }
  if (!items.length) throw new ApiError(400, 'Your cart is empty', ERROR_CODES.CART_EMPTY);

  // RULE 9/10: a coupon sent with COD is dropped here and rejected by the
  // pricing engine, so the API behaves the same as the UI.
  const couponCode = input.paymentMethod === PAYMENT_METHODS.COD ? null : input.couponCode ?? null;

  // Recompute from scratch, in strict mode. Throws on stock/MOQ/coupon/COD
  // problems rather than silently adjusting.
  const pricing = await calculateOrderPricing({
    userId: input.userId,
    items,
    couponCode,
    paymentMethod: input.paymentMethod,
    pincode: address.pincode,
    strict: true,
  });

  assertQuotedTotalMatches(input.expectedTotal, pricing.summary.grandTotal);

  if (settings.minOrderAmount > 0 && pricing.summary.grandTotal < settings.minOrderAmount) {
    throw ApiError.badRequest(
      `Minimum order value is ₹${settings.minOrderAmount.toLocaleString('en-IN')}`,
      'BELOW_MIN_ORDER',
    );
  }

  const user = await User.findById(input.userId).select('name mobile').lean();
  if (!user) throw ApiError.notFound('User not found');

  const isCod = input.paymentMethod === PAYMENT_METHODS.COD;
  const advanceAmount = isCod ? pricing.cod.advanceAmount : 0;
  const remainingCod = isCod ? money(pricing.summary.grandTotal - advanceAmount) : 0;

  await reserveStock(
    pricing.items.map((i) => ({ productId: i.productId, quantity: i.quantity, name: i.name })),
  );

  let order: IOrder;
  try {
    const estimatedDeliveryDate = new Date(
      Date.now() + (pricing.summary.estimatedDeliveryDays ?? 4) * 86_400_000,
    );

    order = await Order.create({
      orderNumber: generateOrderNumber(),
      userId: input.userId,
      customerName: user.name,
      customerMobile: user.mobile,

      items: pricing.items.map(toOrderItem),

      itemsGross: pricing.summary.itemsGross,
      quantityDiscountTotal: pricing.summary.quantityDiscountTotal,
      itemsSubtotal: pricing.summary.itemsSubtotal,
      couponCode: pricing.summary.couponApplied ? pricing.summary.couponCode : null,
      couponId: pricing.summary.couponApplied ? pricing.summary.couponId : null,
      couponDiscount: pricing.summary.couponDiscount,
      taxableAmount: pricing.summary.taxableAmount,
      gstTotal: pricing.summary.gstTotal,
      deliveryCharge: pricing.summary.deliveryCharge,
      grandTotal: pricing.summary.grandTotal,
      totalSavings: pricing.summary.totalSavings,

      paymentMethod: input.paymentMethod,
      paymentStatus: PAYMENT_STATUS.PENDING,
      advanceAmount,
      advancePaidAmount: 0,
      remainingCodAmount: isCod ? remainingCod : 0,
      amountPaidOnline: 0,

      address: snapshotAddress(address),
      status: ORDER_STATUS.PENDING,
      statusHistory: [{ status: ORDER_STATUS.PENDING, at: new Date(), note: 'Order created' }],
      estimatedDeliveryDate,
      customerNote: input.customerNote,

      stockRestored: false,
      pricingContext: {
        gstMode: settings.gstMode,
        quantityDiscountResolution: settings.quantityDiscountResolution,
        deliveryMode: settings.deliveryMode,
        codMaxOrderAmount: settings.codMaxOrderAmount,
        codAdvanceMode: settings.codAdvanceMode,
        codAdvanceAmount: settings.codAdvanceAmount,
        pricedAt: pricing.context.pricedAt,
      },
    });
  } catch (err) {
    // Creation failed after stock was taken - give it straight back.
    const ops = pricing.items.map((item) => ({
      updateOne: { filter: { _id: item.productId }, update: { $inc: { stock: item.quantity } } },
    }));
    if (ops.length) await Product.bulkWrite(ops, { ordered: false });
    throw err;
  }

  // Amount due through the gateway right now: the full total for online, or
  // just the advance for COD.
  const amountDueNow = isCod ? advanceAmount : pricing.summary.grandTotal;

  let paymentHandoff: CreateOrderResult['payment'] = {
    required: false,
    purpose: null,
    amount: 0,
    paymentId: null,
    providerOrderId: null,
    provider: null,
    publicKey: null,
    currency: settings.currency,
  };

  if (amountDueNow > 0) {
    const purpose = isCod ? PAYMENT_PURPOSE.COD_ADVANCE : PAYMENT_PURPOSE.FULL;
    const txn = await initiatePayment(order, purpose, amountDueNow);
    paymentHandoff = {
      required: true,
      purpose,
      amount: amountDueNow,
      paymentId: String(txn.payment._id),
      providerOrderId: txn.gatewayOrder.providerOrderId,
      provider: txn.gatewayOrder.provider,
      publicKey: txn.gatewayOrder.publicKey,
      currency: txn.gatewayOrder.currency,
    };
  } else {
    // Advance requirement switched off by the admin: a COD order with nothing
    // to pay online is confirmed straight away.
    await confirmOrder(order, { reason: 'No advance payment required' });
  }

  await notify.notifyOrderPlaced({
    userId: order.userId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    total: order.grandTotal,
  });

  return { order, pricing, payment: paymentHandoff };
}

// ---------------------------------------------------------------------------
// Payment initiation / verification
// ---------------------------------------------------------------------------

/**
 * Creates a gateway order and the matching Payment row. `expectedAmount` is
 * written here, server-side, and is the only amount trusted at verification.
 */
export async function initiatePayment(order: IOrder, purpose: string, amount: number) {
  const receipt = generateReceiptId(purpose === PAYMENT_PURPOSE.COD_ADVANCE ? 'adv' : 'ord');
  const g = gateway();

  const gatewayOrder = await g.createOrder({
    amount,
    receipt,
    notes: { orderNumber: order.orderNumber, orderId: String(order._id), purpose },
  });

  const payment = await Payment.create({
    orderId: order._id,
    userId: order.userId,
    purpose,
    provider: gatewayOrder.provider,
    providerOrderId: gatewayOrder.providerOrderId,
    receipt,
    expectedAmount: money(amount),
    currency: gatewayOrder.currency,
    status: TXN_STATUS.CREATED,
  });

  return { payment, gatewayOrder };
}

/**
 * Re-opens payment for an order stuck at PENDING - the "retry payment" button.
 * Reuses the outstanding amount rather than recomputing, so a price change
 * mid-flight cannot alter what the customer already committed to.
 */
export async function retryPayment(orderId: string, userId: string | Types.ObjectId) {
  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) throw ApiError.notFound('Order not found');

  if (order.status !== ORDER_STATUS.PENDING) {
    throw ApiError.badRequest('This order does not need a payment', 'PAYMENT_NOT_REQUIRED');
  }

  const isCod = order.paymentMethod === PAYMENT_METHODS.COD;
  const purpose = isCod ? PAYMENT_PURPOSE.COD_ADVANCE : PAYMENT_PURPOSE.FULL;
  const due = isCod
    ? money(order.advanceAmount - order.advancePaidAmount)
    : money(order.grandTotal - order.amountPaidOnline);

  if (due <= 0) {
    await confirmOrder(order, { reason: 'Nothing further due' });
    return { order, payment: null, gatewayOrder: null };
  }

  // Abandon any earlier attempt that never completed.
  await Payment.updateMany(
    { orderId: order._id, purpose, status: TXN_STATUS.CREATED },
    { $set: { status: TXN_STATUS.FAILED, failureReason: 'Superseded by a new attempt' } },
  );

  const txn = await initiatePayment(order, purpose, due);
  return { order, payment: txn.payment, gatewayOrder: txn.gatewayOrder };
}

/**
 * Verifies a completed gateway payment and confirms the order.
 *
 * Everything here is idempotent: a duplicated success callback finds the
 * transaction already SUCCESS and returns the same result instead of
 * double-crediting the order or double-counting the coupon.
 */
export async function verifyPaymentAndConfirm(params: {
  userId: string | Types.ObjectId;
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}): Promise<{ order: IOrder; alreadyProcessed: boolean }> {
  const payment = await Payment.findOne({ providerOrderId: params.providerOrderId });
  if (!payment) throw ApiError.notFound('Payment record not found');

  // A customer may only settle their own payment.
  if (String(payment.userId) !== String(params.userId)) {
    throw ApiError.forbidden('This payment does not belong to your account');
  }

  const order = await Order.findById(payment.orderId);
  if (!order) throw ApiError.notFound('Order not found');

  if (payment.status === TXN_STATUS.SUCCESS) {
    return { order, alreadyProcessed: true };
  }

  const { verifyGatewayPayment, redactGatewayPayload } = await import('./payment.service');

  let fetched;
  try {
    fetched = await verifyGatewayPayment({
      providerOrderId: params.providerOrderId,
      providerPaymentId: params.providerPaymentId,
      signature: params.signature,
      expectedAmount: payment.expectedAmount,
    });
  } catch (err) {
    payment.status = TXN_STATUS.FAILED;
    payment.providerPaymentId = params.providerPaymentId;
    payment.failureReason = err instanceof ApiError ? err.message : 'Verification failed';
    await payment.save().catch(() => undefined);

    await notify.notifyPaymentFailed({
      userId: order.userId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      reason:
        payment.purpose === PAYMENT_PURPOSE.COD_ADVANCE
          ? `The advance payment for order ${order.orderNumber} could not be verified. Your order is not confirmed yet.`
          : undefined,
    });

    // Spec section 19: a failed advance must NOT confirm the COD order. The
    // order stays PENDING and the customer can retry.
    throw err;
  }

  payment.status = TXN_STATUS.SUCCESS;
  payment.providerPaymentId = fetched.providerPaymentId;
  payment.providerSignature = params.signature;
  payment.capturedAmount = fetched.amountMinor / 100;
  payment.method = fetched.method ?? null;
  payment.bank = fetched.bank ?? null;
  payment.wallet = fetched.wallet ?? null;
  payment.vpa = fetched.vpa ?? null;
  payment.cardLast4 = fetched.cardLast4 ?? null;
  payment.verifiedAt = new Date();
  payment.gatewayResponse = redactGatewayPayload(fetched as unknown as Record<string, unknown>);
  await payment.save();

  const paidAmount = money(payment.capturedAmount ?? payment.expectedAmount);
  const isAdvance = payment.purpose === PAYMENT_PURPOSE.COD_ADVANCE;

  order.amountPaidOnline = money(order.amountPaidOnline + paidAmount);
  if (isAdvance) {
    order.advancePaidAmount = money(order.advancePaidAmount + paidAmount);
    order.remainingCodAmount = money(Math.max(0, order.grandTotal - order.advancePaidAmount));
    order.paymentStatus = PAYMENT_STATUS.ADVANCE_PAID;
  } else {
    order.paymentStatus =
      toPaise(order.amountPaidOnline) >= toPaise(order.grandTotal)
        ? PAYMENT_STATUS.PAID
        : PAYMENT_STATUS.PENDING;
  }
  order.paidAt = new Date();

  await confirmOrder(order, { reason: isAdvance ? 'Advance payment verified' : 'Payment verified' });

  await notify.notifyPaymentSuccess({
    userId: order.userId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    amount: paidAmount,
    isAdvance,
    remainingCod: order.remainingCodAmount,
  });

  return { order, alreadyProcessed: false };
}

/**
 * Moves a PENDING order to CONFIRMED and runs the one-time side effects:
 * coupon redemption, sold counters and clearing the cart.
 */
async function confirmOrder(order: IOrder, opts: { reason?: string } = {}): Promise<IOrder> {
  if (order.status !== ORDER_STATUS.PENDING) {
    await order.save();
    return order;
  }

  order.status = ORDER_STATUS.CONFIRMED;
  order.statusHistory.push({
    status: ORDER_STATUS.CONFIRMED,
    at: new Date(),
    note: opts.reason ?? 'Order confirmed',
  });
  await order.save();

  // Coupon redemption is recorded only now, on a genuinely confirmed order, so
  // an abandoned checkout never consumes a usage slot.
  if (order.couponId && order.couponDiscount > 0) {
    await recordRedemption({
      couponId: order.couponId as Types.ObjectId,
      code: order.couponCode ?? '',
      userId: order.userId,
      orderId: order._id,
      discountAmount: order.couponDiscount,
    }).catch((err) => logger.error('[order] coupon redemption failed', err));
  }

  await Product.bulkWrite(
    order.items.map((item) => ({
      updateOne: { filter: { _id: item.productId }, update: { $inc: { soldCount: item.quantity } } },
    })),
    { ordered: false },
  ).catch((err) => logger.warn('[order] soldCount update failed', err));

  await clearCart(order.userId).catch((err) => logger.warn('[order] cart clear failed', err));

  await notify.notifyOrderStatus({
    userId: order.userId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: ORDER_STATUS.CONFIRMED,
  });

  return order;
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

export async function updateOrderStatus(params: {
  orderId: string;
  status: OrderStatus;
  note?: string;
  actorId?: Types.ObjectId;
  actorRole?: string;
  trackingNumber?: string;
  courierName?: string;
}): Promise<IOrder> {
  const order = await Order.findById(params.orderId);
  if (!order) throw ApiError.notFound('Order not found');

  const allowed = ORDER_STATUS_FLOW[order.status] ?? [];
  if (!allowed.includes(params.status)) {
    throw new ApiError(
      422,
      `An order that is ${order.status.toLowerCase().replace(/_/g, ' ')} cannot move to ` +
        `${params.status.toLowerCase().replace(/_/g, ' ')}`,
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      { currentStatus: order.status, allowedTransitions: allowed },
    );
  }

  order.status = params.status;
  order.statusHistory.push({
    status: params.status,
    note: params.note,
    changedBy: params.actorId,
    changedByRole: params.actorRole,
    at: new Date(),
  });

  if (params.trackingNumber) order.trackingNumber = params.trackingNumber;
  if (params.courierName) order.courierName = params.courierName;

  if (params.status === ORDER_STATUS.DELIVERED) {
    order.deliveredAt = new Date();
    // COD balance is collected at the door, so delivery settles the payment.
    if (order.paymentMethod === PAYMENT_METHODS.COD && order.remainingCodAmount > 0) {
      order.paymentStatus = PAYMENT_STATUS.COD_COLLECTED;
      order.codCollectedAt = new Date();
    }
  }

  if (params.status === ORDER_STATUS.CANCELLED) {
    order.cancelledAt = new Date();
    order.cancelReason = params.note;
    order.cancelledByRole = params.actorRole;
    await restoreStock(order);
    await releaseRedemption(order._id).catch((err) => logger.warn('[order] coupon release failed', err));
  }

  if (params.status === ORDER_STATUS.RETURNED) {
    order.returnReason = params.note;
    await restoreStock(order);
  }

  await order.save();

  await notify.notifyOrderStatus({
    userId: order.userId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    status: params.status,
  });

  return order;
}

// ---------------------------------------------------------------------------
// COD collection and refunds (admin, spec sections 21, 25)
// ---------------------------------------------------------------------------

/**
 * Records the cash collected against a COD order. The amount defaults to the
 * whole outstanding balance; a partial amount is allowed (a driver who could
 * only collect part of it) and never over-collection. Purely a bookkeeping
 * settlement - it changes payment status, not order status.
 */
export async function recordCodCollection(params: {
  orderId: string;
  amount?: number;
  note?: string;
  actorId?: Types.ObjectId;
}): Promise<IOrder> {
  const order = await Order.findById(params.orderId);
  if (!order) throw ApiError.notFound('Order not found');

  if (order.paymentMethod !== PAYMENT_METHODS.COD) {
    throw ApiError.badRequest(
      'Only cash-on-delivery orders have a balance to collect',
      'NOT_A_COD_ORDER',
    );
  }
  if (order.remainingCodAmount <= 0 || order.paymentStatus === PAYMENT_STATUS.COD_COLLECTED) {
    throw ApiError.badRequest(
      'There is no outstanding cash-on-delivery amount on this order',
      'COD_ALREADY_COLLECTED',
    );
  }

  const amount = params.amount === undefined ? order.remainingCodAmount : money(params.amount);
  if (amount <= 0) throw ApiError.badRequest('Enter a valid collection amount');
  if (toPaise(amount) > toPaise(order.remainingCodAmount)) {
    throw ApiError.badRequest(
      `The amount collected cannot exceed the outstanding ₹${order.remainingCodAmount.toLocaleString('en-IN')}`,
      'COD_OVER_COLLECTION',
    );
  }

  order.remainingCodAmount = money(order.remainingCodAmount - amount);
  order.codCollectedAt = new Date();
  if (order.remainingCodAmount <= 0) order.paymentStatus = PAYMENT_STATUS.COD_COLLECTED;
  order.statusHistory.push({
    status: order.status,
    note: `COD collected: ₹${amount.toLocaleString('en-IN')}${params.note ? ` — ${params.note}` : ''}`,
    changedBy: params.actorId,
    changedByRole: 'ADMIN',
    at: new Date(),
  });
  await order.save();

  logger.info(`[order] recorded COD collection of ₹${amount} for order ${order.orderNumber}`);
  return order;
}

/**
 * Issues a refund against the money captured online for an order (RULE 16 in
 * reverse - the gateway is still the authority, so we refund a real captured
 * transaction and record what it returned). The amount defaults to the full
 * refundable balance and can never exceed what was captured.
 */
export async function refundOrderPayment(params: {
  orderId: string;
  amount?: number;
  reason: string;
  actorId?: Types.ObjectId;
}): Promise<{ order: IOrder; payment: IPayment; refundId: string; amount: number }> {
  const order = await Order.findById(params.orderId);
  if (!order) throw ApiError.notFound('Order not found');

  if (order.amountPaidOnline <= 0) {
    throw ApiError.badRequest('This order has no online payment to refund', 'NOTHING_TO_REFUND');
  }

  // Refund against the largest captured transaction that still has headroom.
  const payment = await Payment.findOne({
    orderId: order._id,
    status: TXN_STATUS.SUCCESS,
    providerPaymentId: { $ne: null },
  }).sort({ capturedAmount: -1, createdAt: -1 });

  if (!payment || !payment.providerPaymentId) {
    throw ApiError.badRequest('No captured payment was found to refund against', 'NOTHING_TO_REFUND');
  }

  const captured = money(payment.capturedAmount ?? payment.expectedAmount);
  const alreadyRefunded = money(payment.refundedAmount ?? 0);
  const refundable = money(captured - alreadyRefunded);
  if (refundable <= 0) {
    throw ApiError.badRequest('This payment has already been fully refunded', 'ALREADY_REFUNDED');
  }

  const amount = params.amount === undefined ? refundable : money(params.amount);
  if (amount <= 0) throw ApiError.badRequest('Enter a valid refund amount');
  if (toPaise(amount) > toPaise(refundable)) {
    throw ApiError.badRequest(
      `The refund cannot exceed the refundable ₹${refundable.toLocaleString('en-IN')}`,
      'REFUND_EXCEEDS_CAPTURED',
    );
  }

  const { refundId } = await gateway().refund(payment.providerPaymentId, amount, {
    orderNumber: order.orderNumber,
    reason: params.reason.slice(0, 200),
  });

  payment.refundedAmount = money(alreadyRefunded + amount);
  payment.refundId = refundId;
  if (toPaise(payment.refundedAmount) >= toPaise(captured)) payment.status = TXN_STATUS.REFUNDED;
  await payment.save();

  // Order-level status reflects the aggregate across every transaction.
  const [agg] = await Payment.aggregate<{ _id: null; refunded: number }>([
    { $match: { orderId: order._id } },
    { $group: { _id: null, refunded: { $sum: '$refundedAmount' } } },
  ]);
  const totalRefunded = toPaise(money(agg?.refunded ?? 0));
  order.paymentStatus =
    totalRefunded >= toPaise(order.amountPaidOnline)
      ? PAYMENT_STATUS.REFUNDED
      : PAYMENT_STATUS.PARTIALLY_REFUNDED;
  order.adminNote = params.reason;
  order.statusHistory.push({
    status: order.status,
    note: `Refund of ₹${amount.toLocaleString('en-IN')} issued — ${params.reason}`,
    changedBy: params.actorId,
    changedByRole: 'ADMIN',
    at: new Date(),
  });
  await order.save();

  logger.info(`[order] refund ${refundId} of ₹${amount} for order ${order.orderNumber}`);
  return { order, payment, refundId, amount };
}

/** Customer-initiated cancellation, subject to status and time window. */
export async function cancelOwnOrder(
  orderId: string,
  userId: string | Types.ObjectId,
  reason?: string,
): Promise<IOrder> {
  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) throw ApiError.notFound('Order not found');

  if (!USER_CANCELLABLE_STATUSES.includes(order.status)) {
    throw new ApiError(
      422,
      `This order can no longer be cancelled because it is already ${order.status
        .toLowerCase()
        .replace(/_/g, ' ')}. Please contact support.`,
      ERROR_CODES.ORDER_NOT_CANCELLABLE,
    );
  }

  const settings = await getSettings();
  const windowHours = settings.customerCancellationWindowHours ?? 24;
  if (windowHours > 0) {
    const elapsedHours = (Date.now() - order.createdAt.getTime()) / 3_600_000;
    if (elapsedHours > windowHours) {
      throw new ApiError(
        422,
        `Orders can only be cancelled within ${windowHours} hours of being placed. Please contact support.`,
        ERROR_CODES.ORDER_NOT_CANCELLABLE,
      );
    }
  }

  return updateOrderStatus({
    orderId,
    status: ORDER_STATUS.CANCELLED,
    note: reason ?? 'Cancelled by customer',
    actorId: order.userId,
    actorRole: 'USER',
  });
}

/**
 * Releases stock held by orders that never completed payment. Intended to run
 * on a schedule; without it an abandoned checkout keeps inventory locked away.
 */
export async function expireStalePendingOrders(olderThanMinutes = 45): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const stale = await Order.find({
    status: ORDER_STATUS.PENDING,
    createdAt: { $lt: cutoff },
    stockRestored: false,
  }).limit(200);

  let count = 0;
  for (const order of stale) {
    // eslint-disable-next-line no-await-in-loop
    const settled = await Payment.exists({ orderId: order._id, status: TXN_STATUS.SUCCESS });
    if (settled) continue;

    order.status = ORDER_STATUS.CANCELLED;
    order.cancelledAt = new Date();
    order.cancelReason = 'Payment not completed in time';
    order.cancelledByRole = 'SYSTEM';
    order.paymentStatus = PAYMENT_STATUS.FAILED;
    order.statusHistory.push({
      status: ORDER_STATUS.CANCELLED,
      note: 'Automatically cancelled - payment not completed',
      at: new Date(),
    });
    // eslint-disable-next-line no-await-in-loop
    await restoreStock(order);
    // eslint-disable-next-line no-await-in-loop
    await order.save();
    count += 1;
  }

  if (count) logger.info(`[order] expired ${count} stale pending order(s)`);
  return count;
}

/** Reorder: returns the items still purchasable today. */
export async function buildReorderItems(orderId: string, userId: string | Types.ObjectId) {
  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw ApiError.notFound('Order not found');

  const products = await Product.find({ _id: { $in: order.items.map((i) => i.productId) } })
    .select('status stock name minOrderQuantity')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const available: { productId: string; quantity: number }[] = [];
  const unavailable: { productId: string; name: string; reason: string }[] = [];

  for (const item of order.items) {
    const product = byId.get(String(item.productId));
    if (!product || product.status !== 'ACTIVE') {
      unavailable.push({ productId: String(item.productId), name: item.name, reason: 'No longer available' });
      continue;
    }
    if (product.stock <= 0) {
      unavailable.push({ productId: String(item.productId), name: item.name, reason: 'Out of stock' });
      continue;
    }
    available.push({
      productId: String(item.productId),
      quantity: Math.max(product.minOrderQuantity ?? 1, Math.min(item.quantity, product.stock)),
    });
  }

  return { available, unavailable };
}
