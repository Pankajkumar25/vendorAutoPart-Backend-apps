import { Types } from 'mongoose';
import { CheckoutSession, type ICheckoutSession } from '../models/checkoutSession.model';
import { Order, type IOrder } from '../models/order.model';
import { Product } from '../models/product.model';
import { Address } from '../models/address.model';
import { User } from '../models/user.model';
import { Payment } from '../models/payment.model';
import {
  ORDER_STATUS,
  PAYMENT_METHODS,
  PAYMENT_PURPOSE,
  PAYMENT_STATUS,
  TXN_STATUS,
  type PaymentMethod,
} from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { generateOrderNumber, generateReceiptId } from '../utils/slug';
import { money } from '../utils/money';
import { logger } from '../config/logger';
import { getSettings } from './settings.service';
import { assertQuotedTotalMatches, calculateOrderPricing, type OrderPricingResult } from './pricing.service';
import { gateway } from './payment.service';
import { recordRedemption } from './coupon.service';
import { clearCart } from './cart.service';
import * as notify from './notification.service';

/**
 * Payment-first checkout flow.
 *
 * 1. `initiateCheckout` — validates everything, reserves stock, creates a
 *    Razorpay order (or marks COD), but does NOT create the real Order yet.
 *    Returns a checkout session + payment handoff.
 *
 * 2. `confirmCheckout` — called after payment success (or immediately for COD).
 *    Creates the real Order, links the payment, confirms it.
 *
 * This ensures no Order exists until the customer has actually paid (or
 * committed to COD).
 */

export interface CheckoutInitiateInput {
  userId: string | Types.ObjectId;
  addressId: string;
  paymentMethod: PaymentMethod;
  couponCode?: string | null;
  customerNote?: string;
  expectedTotal?: number;
}

export interface CheckoutInitiateResult {
  sessionId: string;
  amountDueNow: number;
  paymentMethod: string;
  /** Present for ONLINE payments. */
  providerOrderId?: string;
  provider?: string;
  publicKey?: string;
  currency?: string;
  /** For COD: 0 — nothing to pay online. */
  amount: number;
  orderNumber: string;
}

export interface ConfirmCheckoutInput {
  userId: string | Types.ObjectId;
  sessionId: string;
  /** Razorpay response fields (only for ONLINE). */
  providerOrderId?: string;
  providerPaymentId?: string;
  signature?: string;
}

// ---------------------------------------------------------------------------
// initiateCheckout
// ---------------------------------------------------------------------------

export async function initiateCheckout(input: CheckoutInitiateInput): Promise<CheckoutInitiateResult> {
  const settings = await getSettings();

  const address = await Address.findOne({
    _id: input.addressId,
    userId: input.userId,
    isDeleted: false,
  });
  if (!address) throw ApiError.notFound('Delivery address not found', ERROR_CODES.ADDRESS_REQUIRED);

  // Get active cart items
  const { Cart } = await import('../models/cart.model');
  const cart = await Cart.findOne({ userId: input.userId }).lean();
  const items = (cart?.items ?? [])
    .filter((i) => !i.savedForLater)
    .map((i) => ({ productId: String(i.productId), quantity: i.quantity }));
  if (!items.length) throw ApiError.badRequest('Your cart is empty', ERROR_CODES.CART_EMPTY);

  const couponCode = input.paymentMethod === PAYMENT_METHODS.COD ? null : input.couponCode ?? null;

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
  const amountDueNow = isCod ? advanceAmount : pricing.summary.grandTotal;

  // Reserve stock
  const { reserveStock } = await import('./order.service');
  await reserveStock(
    pricing.items.map((i) => ({ productId: i.productId, quantity: i.quantity, name: i.name })),
  );

  const orderNumber = generateOrderNumber();

  // Build address snapshot
  const addressSnapshot = {
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
    addressType: address.addressType,
  };

  // Create checkout session
  const session = await CheckoutSession.create({
    userId: input.userId,
    items: pricing.items.map((item) => ({
      productId: new Types.ObjectId(item.productId),
      quantity: item.quantity,
      name: item.name,
      partNumber: item.partNumber,
      sku: item.sku,
      image: item.image ?? '',
      unitPrice: item.effectiveUnitPrice,
      mrp: item.mrp,
      gstRate: item.gstRate,
      weight: item.weight,
      quantityDiscountAmount: item.quantityDiscount.amount,
      lineTotal: item.lineTotal,
    })),
    address: addressSnapshot,
    paymentMethod: input.paymentMethod,
    couponCode: pricing.summary.couponApplied ? pricing.summary.couponCode : null,
    couponId: pricing.summary.couponId ? new Types.ObjectId(pricing.summary.couponId) : null,
    customerNote: input.customerNote,

    itemsGross: pricing.summary.itemsGross,
    quantityDiscountTotal: pricing.summary.quantityDiscountTotal,
    itemsSubtotal: pricing.summary.itemsSubtotal,
    couponDiscount: pricing.summary.couponDiscount,
    taxableAmount: pricing.summary.taxableAmount,
    gstTotal: pricing.summary.gstTotal,
    deliveryCharge: pricing.summary.deliveryCharge,
    grandTotal: pricing.summary.grandTotal,
    totalSavings: pricing.summary.totalSavings,
    advanceAmount,
    remainingCodAmount: remainingCod,
    amountDueNow,

    status: 'PENDING',
  });

  let result: CheckoutInitiateResult = {
    sessionId: String(session._id),
    amountDueNow,
    paymentMethod: input.paymentMethod,
    amount: amountDueNow,
    orderNumber,
  };

  // For ONLINE: create Razorpay order
  if (amountDueNow > 0 && !isCod) {
    const g = gateway();
    const receipt = generateReceiptId('ord');
    const gatewayOrder = await g.createOrder({
      amount: amountDueNow,
      receipt,
      notes: { orderNumber, sessionId: String(session._id) },
    });

    // Update session with gateway info
    session.providerOrderId = gatewayOrder.providerOrderId;
    session.provider = gatewayOrder.provider;
    session.publicKey = gatewayOrder.publicKey;
    session.currency = gatewayOrder.currency;
    await session.save();

    result.providerOrderId = gatewayOrder.providerOrderId;
    result.provider = gatewayOrder.provider;
    result.publicKey = gatewayOrder.publicKey;
    result.currency = gatewayOrder.currency;
  }

  return result;
}

// ---------------------------------------------------------------------------
// confirmCheckout
// ---------------------------------------------------------------------------

export async function confirmCheckout(input: ConfirmCheckoutInput): Promise<{ order: IOrder }> {
  const session = await CheckoutSession.findById(input.sessionId);
  if (!session) throw ApiError.notFound('Checkout session not found');
  if (String(session.userId) !== String(input.userId)) {
    throw ApiError.forbidden('This checkout session does not belong to your account');
  }
  if (session.status !== 'PENDING') {
    throw ApiError.badRequest('This checkout session has already been processed');
  }

  const isCod = session.paymentMethod === PAYMENT_METHODS.COD;

  // For ONLINE: verify payment first
  if (!isCod) {
    if (!input.providerOrderId || !input.providerPaymentId || !input.signature) {
      throw ApiError.badRequest('Payment details are required for online orders');
    }

    const { verifyGatewayPayment, redactGatewayPayload } = await import('./payment.service');

    // Find or create payment record
    let payment = await Payment.findOne({ providerOrderId: input.providerOrderId });
    if (!payment) {
      // First time — create the payment record now
      const receipt = generateReceiptId('pay');
      payment = await Payment.create({
        orderId: new Types.ObjectId(), // placeholder — linked below
        userId: input.userId,
        purpose: PAYMENT_PURPOSE.FULL,
        provider: session.provider ?? 'razorpay',
        providerOrderId: input.providerOrderId,
        receipt,
        expectedAmount: money(session.amountDueNow),
        currency: session.currency ?? 'INR',
        status: TXN_STATUS.CREATED,
      });
    }
    if (String(payment.userId) !== String(input.userId)) {
      throw ApiError.forbidden('This payment does not belong to your account');
    }

    // Already processed
    if (payment.status === TXN_STATUS.SUCCESS) {
      const existingOrder = await Order.findById(payment.orderId);
      if (existingOrder) return { order: existingOrder };
    }

    // Verify with gateway (skip for mock — simulate already marked it SUCCESS)
    if (payment.status !== TXN_STATUS.SUCCESS) {
      const { verifyGatewayPayment, redactGatewayPayload } = await import('./payment.service');
      let fetched;
      try {
        fetched = await verifyGatewayPayment({
          providerOrderId: input.providerOrderId,
          providerPaymentId: input.providerPaymentId,
          signature: input.signature,
          expectedAmount: payment.expectedAmount,
        });
      } catch (err) {
        payment.status = TXN_STATUS.FAILED;
        payment.providerPaymentId = input.providerPaymentId;
        payment.failureReason = err instanceof ApiError ? err.message : 'Verification failed';
        await payment.save().catch(() => undefined);
        throw err;
      }
      payment.providerPaymentId = fetched.providerPaymentId;
      payment.providerSignature = input.signature;
      payment.capturedAmount = fetched.amountMinor / 100;
      payment.method = fetched.method ?? null;
      payment.bank = fetched.bank ?? null;
      payment.wallet = fetched.wallet ?? null;
      payment.vpa = fetched.vpa ?? null;
      payment.cardLast4 = fetched.cardLast4 ?? null;
      payment.verifiedAt = new Date();
      payment.gatewayResponse = redactGatewayPayload(fetched as unknown as Record<string, unknown>);
    }

    // NOW create the Order (payment verified)
    const order = await createOrderFromSession(session);

    // Link payment to order
    payment.orderId = order._id;
    payment.status = TXN_STATUS.SUCCESS;
    await payment.save();

    // Update order with payment info
    order.amountPaidOnline = money(payment.capturedAmount ?? payment.expectedAmount);
    order.paymentStatus =
      order.amountPaidOnline >= order.grandTotal ? PAYMENT_STATUS.PAID : PAYMENT_STATUS.PENDING;
    order.paidAt = new Date();
    await order.save();

    // Confirm order
    await confirmOrder(order, { reason: 'Payment verified' });

    // Mark session done
    session.status = 'COMPLETED';
    await session.save();

    // Notify
    await notify.notifyOrderPlaced({
      userId: order.userId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      total: order.grandTotal,
    });

    await notify.notifyPaymentSuccess({
      userId: order.userId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      amount: payment.capturedAmount ?? payment.expectedAmount,
      isAdvance: false,
    });

    return { order };
  }

  // COD: create order directly
  const order = await createOrderFromSession(session);

  // Mark session done
  session.status = 'COMPLETED';
  await session.save();

  // For COD with advance: initiate advance payment
  if (session.advanceAmount > 0) {
    const purpose = PAYMENT_PURPOSE.COD_ADVANCE;
    const receipt = generateReceiptId('adv');
    const g = gateway();
    const gatewayOrder = await g.createOrder({
      amount: session.advanceAmount,
      receipt,
      notes: { orderNumber: order.orderNumber, orderId: String(order._id), purpose },
    });

    await Payment.create({
      orderId: order._id,
      userId: order.userId,
      purpose,
      provider: gatewayOrder.provider,
      providerOrderId: gatewayOrder.providerOrderId,
      receipt,
      expectedAmount: money(session.advanceAmount),
      currency: gatewayOrder.currency,
      status: TXN_STATUS.CREATED,
    });

    // Notify
    await notify.notifyOrderPlaced({
      userId: order.userId,
      orderId: order._id,
      orderNumber: order.orderNumber,
      total: order.grandTotal,
    });

    // Return order with advance payment handoff
    return { order };
  }

  // COD with no advance: confirm immediately
  await confirmOrder(order, { reason: 'COD order placed' });

  await notify.notifyOrderPlaced({
    userId: order.userId,
    orderId: order._id,
    orderNumber: order.orderNumber,
    total: order.grandTotal,
  });

  return { order };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createOrderFromSession(session: ICheckoutSession): Promise<IOrder> {
  const settings = await getSettings();

  const order = await Order.create({
    orderNumber: generateOrderNumber(),
    userId: session.userId,
    customerName: session.address.fullName,
    customerMobile: session.address.mobile,

    items: session.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      partNumber: item.partNumber,
      sku: item.sku ?? '',
      brand: '',
      image: item.image,
      quantity: item.quantity,
      unit: 'unit',
      mrp: item.mrp,
      basePrice: item.unitPrice,
      userPrice: null,
      effectiveUnitPrice: item.unitPrice,
      quantityDiscountPercentage: 0,
      quantityDiscountAmount: item.quantityDiscountAmount,
      grossAmount: item.lineTotal,
      lineSubtotal: item.lineTotal,
      couponDiscountShare: 0,
      taxableAmount: item.lineTotal,
      gstRate: item.gstRate,
      gstAmount: 0,
      lineTotal: item.lineTotal,
    })),

    itemsGross: session.itemsGross,
    quantityDiscountTotal: session.quantityDiscountTotal,
    itemsSubtotal: session.itemsSubtotal,
    couponCode: session.couponCode,
    couponId: session.couponId,
    couponDiscount: session.couponDiscount,
    taxableAmount: session.taxableAmount,
    gstTotal: session.gstTotal,
    deliveryCharge: session.deliveryCharge,
    grandTotal: session.grandTotal,
    totalSavings: session.totalSavings,

    paymentMethod: session.paymentMethod as PaymentMethod,
    paymentStatus: PAYMENT_STATUS.PENDING,
    advanceAmount: session.advanceAmount,
    advancePaidAmount: 0,
    remainingCodAmount: session.remainingCodAmount,
    amountPaidOnline: 0,

    address: {
      fullName: session.address.fullName,
      mobile: session.address.mobile,
      alternateMobile: session.address.alternateMobile,
      houseNumber: session.address.houseNumber,
      street: session.address.street,
      area: session.address.area,
      landmark: session.address.landmark,
      city: session.address.city,
      state: session.address.state,
      pincode: session.address.pincode,
      country: session.address.country,
      addressType: session.address.addressType,
    },

    status: ORDER_STATUS.PENDING,
    statusHistory: [{ status: ORDER_STATUS.PENDING, at: new Date(), note: 'Order created' }],
    estimatedDeliveryDate: new Date(
      Date.now() + (settings.estimatedDeliveryDays ?? 4) * 86_400_000,
    ),
    customerNote: session.customerNote,

    stockRestored: false,
    pricingContext: {
      gstMode: settings.gstMode,
      quantityDiscountResolution: settings.quantityDiscountResolution,
      deliveryMode: settings.deliveryMode,
      codMaxOrderAmount: settings.codMaxOrderAmount,
      codAdvanceMode: settings.codAdvanceMode,
      codAdvanceAmount: settings.codAdvanceAmount,
      pricedAt: new Date(),
    },
  });

  // Fetch user name
  const user = await User.findById(session.userId).select('name').lean();
  if (user) {
    order.customerName = user.name;
    await order.save();
  }

  // Clear cart
  await clearCart(session.userId);

  // Record coupon redemption
  if (session.couponId && session.couponCode && session.couponDiscount > 0) {
    await recordRedemption({
      couponId: session.couponId,
      code: session.couponCode,
      userId: session.userId,
      orderId: order._id,
      discountAmount: session.couponDiscount,
    }).catch((err) => logger.warn('[checkout] failed to record coupon redemption', err));
  }

  return order;
}

async function confirmOrder(order: IOrder, opts: { reason?: string } = {}): Promise<void> {
  if (order.status !== ORDER_STATUS.PENDING) {
    await order.save();
    return;
  }

  order.status = ORDER_STATUS.CONFIRMED;
  order.statusHistory.push({
    status: ORDER_STATUS.CONFIRMED,
    at: new Date(),
    note: opts.reason ?? 'Order confirmed',
  });
  await order.save();
}
