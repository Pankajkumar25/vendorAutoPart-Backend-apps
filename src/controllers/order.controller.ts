import type { Request, Response } from 'express';
import { Order, type IOrder } from '../models/order.model';
import { Address } from '../models/address.model';
import { Payment } from '../models/payment.model';
import * as orderService from '../services/order.service';
import { getCartView, addToCart } from '../services/cart.service';
import { getSettings } from '../services/settings.service';
import { requireAuth } from '../middleware/auth.middleware';
import { created, ok, paginated } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import { buildPaginationMeta, parsePagination } from '../utils/pagination';
import { money } from '../utils/money';
import {
  ORDER_STATUS,
  PAYMENT_METHODS,
  USER_CANCELLABLE_STATUSES,
  type PaymentMethod,
} from '../config/constants';

/**
 * Orders, customer side (spec sections 21-24, 26).
 *
 * The checkout preview and the order itself are priced by the same engine call.
 * `placeOrder` passes nothing from the request body into the money maths except
 * product ids, quantities, a coupon *code* and the payment method - the total is
 * recomputed server-side and, if the client echoes the figure it displayed, a
 * mismatch is refused rather than silently repriced (RULES 14, 15).
 */

/** Trimmed shape for the order-history list. */
function toOrderSummary(order: IOrder) {
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    grandTotal: order.grandTotal,
    totalSavings: order.totalSavings,
    itemCount: order.items.length,
    totalQuantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
    // Enough to draw the thumbnail stack on the card.
    thumbnails: order.items.slice(0, 3).map((item) => item.image ?? null),
    firstItemName: order.items[0]?.name ?? '',
    remainingCodAmount: order.remainingCodAmount,
    advanceAmount: order.advanceAmount,
    advancePaidAmount: order.advancePaidAmount,
    estimatedDeliveryDate: order.estimatedDeliveryDate ?? null,
    deliveredAt: order.deliveredAt ?? null,
    trackingNumber: order.trackingNumber ?? null,
    courierName: order.courierName ?? null,
    canCancel: USER_CANCELLABLE_STATUSES.includes(order.status),
    needsPayment: order.status === ORDER_STATUS.PENDING,
    createdAt: order.createdAt,
  };
}

function toOrderDetail(order: IOrder) {
  return {
    ...toOrderSummary(order),
    items: order.items.map((item) => ({
      productId: String(item.productId),
      name: item.name,
      sku: item.sku,
      partNumber: item.partNumber,
      brand: item.brand,
      image: item.image ?? null,
      unit: item.unit,
      quantity: item.quantity,
      mrp: item.mrp,
      // The price this customer actually got, frozen at order time.
      unitPrice: item.effectiveUnitPrice,
      quantityDiscountPercentage: item.quantityDiscountPercentage,
      quantityDiscountAmount: item.quantityDiscountAmount,
      grossAmount: item.grossAmount,
      lineSubtotal: item.lineSubtotal,
      couponDiscountShare: item.couponDiscountShare,
      gstRate: item.gstRate,
      gstAmount: item.gstAmount,
      lineTotal: item.lineTotal,
    })),
    charges: {
      itemsGross: order.itemsGross,
      quantityDiscountTotal: order.quantityDiscountTotal,
      itemsSubtotal: order.itemsSubtotal,
      couponCode: order.couponCode ?? null,
      couponDiscount: order.couponDiscount,
      taxableAmount: order.taxableAmount,
      gstTotal: order.gstTotal,
      deliveryCharge: order.deliveryCharge,
      adjustmentAmount: order.adjustmentAmount,
      adjustmentReason: order.adjustmentReason ?? null,
      grandTotal: order.grandTotal,
      totalSavings: order.totalSavings,
    },
    payment: {
      method: order.paymentMethod,
      status: order.paymentStatus,
      amountPaidOnline: order.amountPaidOnline,
      advanceAmount: order.advanceAmount,
      advancePaidAmount: order.advancePaidAmount,
      remainingCodAmount: order.remainingCodAmount,
      paidAt: order.paidAt ?? null,
      codCollectedAt: order.codCollectedAt ?? null,
    },
    address: order.address,
    statusHistory: order.statusHistory.map((event) => ({
      status: event.status,
      note: event.note ?? null,
      at: event.at,
    })),
    customerNote: order.customerNote ?? null,
    cancelReason: order.cancelReason ?? null,
    returnReason: order.returnReason ?? null,
  };
}

/** Loads an order that belongs to the caller, by id or order number. */
async function findOwnOrder(req: Request): Promise<IOrder> {
  const auth = requireAuth(req);
  const identifier = req.params.id;
  const order = await Order.findOne({
    userId: auth.userId,
    ...(/^[0-9a-fA-F]{24}$/.test(identifier) ? { _id: identifier } : { orderNumber: identifier.toUpperCase() }),
  });
  if (!order) throw ApiError.notFound('Order not found');
  return order;
}

/**
 * Checkout screen (spec section 21): the cart priced against a chosen address
 * and payment method, plus which payment methods are actually available.
 *
 * COD availability comes from the engine, never from the client - so a customer
 * who forces `paymentMethod: COD` on a ₹30,000 order sees the same refusal the
 * UI would have shown (RULE 11).
 */
export async function getCheckoutPreview(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const source = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };

  const paymentMethod = (source.paymentMethod as PaymentMethod | undefined) ?? PAYMENT_METHODS.ONLINE;
  const couponCode = typeof source.couponCode === 'string' ? source.couponCode : undefined;

  const [settings, addresses] = await Promise.all([
    getSettings(),
    Address.find({ userId: auth.userId, isDeleted: false })
      .sort({ isDefault: -1, updatedAt: -1 })
      .lean({ virtuals: true }),
  ]);

  const requestedAddressId = source.addressId ? String(source.addressId) : null;
  const address = requestedAddressId
    ? addresses.find((a) => String(a._id) === requestedAddressId)
    : addresses.find((a) => a.isDefault) ?? addresses[0];

  if (requestedAddressId && !address) throw ApiError.notFound('Delivery address not found');

  const view = await getCartView(auth.userId, {
    paymentMethod,
    couponCode,
    pincode: address?.pincode ?? null,
  });

  ok(res, {
    ...view,
    address: address ?? null,
    addresses,
    paymentOptions: [
      {
        method: PAYMENT_METHODS.ONLINE,
        label: 'Pay online',
        available: true,
        // Only the online route can carry a coupon (RULE 9).
        supportsCoupon: true,
        payableNow: view.pricing.summary.grandTotal,
        note: 'UPI, cards, netbanking and wallets',
      },
      {
        method: PAYMENT_METHODS.COD,
        label: 'Cash on delivery',
        available: view.pricing.cod.available,
        supportsCoupon: false,
        unavailableReason: view.pricing.cod.reason,
        payableNow: view.pricing.cod.advanceAmount,
        payableOnDelivery: view.pricing.cod.remainingCodAmount,
        note: view.pricing.cod.advanceRequired
          ? `₹${view.pricing.cod.advanceAmount.toLocaleString('en-IN')} advance online, balance in cash`
          : 'Pay the full amount in cash on delivery',
      },
    ],
    minOrderAmount: settings.minOrderAmount,
    meetsMinimumOrder: view.pricing.summary.grandTotal >= settings.minOrderAmount,
  });
}

export async function placeOrder(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const result = await orderService.createOrder({
    userId: auth.userId,
    addressId: req.body.addressId,
    paymentMethod: req.body.paymentMethod,
    couponCode: req.body.couponCode ?? null,
    customerNote: req.body.customerNote,
    // Tripwire only: if this disagrees with the server's total, the order is
    // refused instead of charged at a price the customer never saw.
    expectedTotal: req.body.expectedTotal,
  });

  created(
    res,
    {
      order: toOrderDetail(result.order),
      pricing: result.pricing,
      payment: result.payment,
    },
    result.payment.required ? 'Order created. Please complete the payment.' : 'Order placed successfully',
  );
}

export async function listMyOrders(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = { userId: auth.userId };
  if (query.status) filter.status = query.status;
  if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
  if (query.search) {
    filter.$or = [
      { orderNumber: new RegExp(String(query.search).trim(), 'i') },
      { 'items.name': new RegExp(String(query.search).trim(), 'i') },
    ];
  }

  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);

  paginated(res, orders.map(toOrderSummary), buildPaginationMeta(page, limit, total));
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const order = await findOwnOrder(req);
  ok(res, toOrderDetail(order));
}

/** Timeline for the tracking screen. */
export async function trackOrder(req: Request, res: Response): Promise<void> {
  const order = await findOwnOrder(req);
  ok(res, {
    orderNumber: order.orderNumber,
    status: order.status,
    estimatedDeliveryDate: order.estimatedDeliveryDate ?? null,
    deliveredAt: order.deliveredAt ?? null,
    trackingNumber: order.trackingNumber ?? null,
    courierName: order.courierName ?? null,
    timeline: order.statusHistory.map((event) => ({
      status: event.status,
      note: event.note ?? null,
      at: event.at,
    })),
  });
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const order = await orderService.cancelOwnOrder(req.params.id, auth.userId, req.body?.reason);
  ok(res, toOrderDetail(order), 'Order cancelled');
}

/**
 * Reorder: puts back everything from a past order that can still be bought
 * today, and reports what could not be added. Prices are whatever the customer's
 * rules say now, not what the old order charged.
 */
export async function reorder(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { available, unavailable } = await orderService.buildReorderItems(req.params.id, auth.userId);

  if (!available.length) {
    throw ApiError.badRequest('None of the items from that order are available right now');
  }

  const failed: { productId: string; name: string; reason: string }[] = [...unavailable];
  for (const item of available) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await addToCart(auth.userId, item.productId, item.quantity, 'set');
    } catch (err) {
      failed.push({
        productId: item.productId,
        name: '',
        reason: err instanceof ApiError ? err.message : 'Could not be added',
      });
    }
  }

  const view = await getCartView(auth.userId, {});
  ok(
    res,
    { ...view, notAdded: failed },
    failed.length ? 'Some items could not be added to your cart' : 'Items added to your cart',
  );
}

/**
 * Invoice data (spec section 26). Rendered by the app; the server supplies the
 * numbers so a PDF can never disagree with what was charged.
 */
export async function getInvoice(req: Request, res: Response): Promise<void> {
  const order = await findOwnOrder(req);
  const settings = await getSettings();

  if (order.status === ORDER_STATUS.PENDING) {
    throw ApiError.badRequest('An invoice is available once your order is confirmed');
  }

  const payments = await Payment.find({ orderId: order._id, status: 'SUCCESS' })
    .select('purpose capturedAmount expectedAmount method providerPaymentId verifiedAt')
    .sort({ verifiedAt: 1 })
    .lean();

  const gstBreakup = order.items.reduce<Record<number, { taxableAmount: number; gstAmount: number }>>(
    (acc, item) => {
      const row = acc[item.gstRate] ?? { taxableAmount: 0, gstAmount: 0 };
      row.taxableAmount = money(row.taxableAmount + item.taxableAmount);
      row.gstAmount = money(row.gstAmount + item.gstAmount);
      acc[item.gstRate] = row;
      return acc;
    },
    {},
  );

  ok(res, {
    invoiceNumber: `INV-${order.orderNumber}`,
    invoiceDate: order.paidAt ?? order.createdAt,
    seller: {
      name: settings.storeName,
      phone: settings.supportPhone ?? null,
      email: settings.supportEmail ?? null,
    },
    order: {
      orderNumber: order.orderNumber,
      placedAt: order.createdAt,
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
    },
    billTo: order.address,
    items: order.items.map((item, index) => ({
      serial: index + 1,
      name: item.name,
      partNumber: item.partNumber,
      hsnCode: null,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.effectiveUnitPrice,
      discount: money(item.quantityDiscountAmount + item.couponDiscountShare),
      taxableAmount: item.taxableAmount,
      gstRate: item.gstRate,
      gstAmount: item.gstAmount,
      lineTotal: item.lineTotal,
    })),
    totals: {
      itemsGross: order.itemsGross,
      quantityDiscountTotal: order.quantityDiscountTotal,
      couponDiscount: order.couponDiscount,
      taxableAmount: order.taxableAmount,
      gstTotal: order.gstTotal,
      gstBreakup: Object.entries(gstBreakup).map(([rate, row]) => ({ rate: Number(rate), ...row })),
      deliveryCharge: order.deliveryCharge,
      adjustmentAmount: order.adjustmentAmount,
      grandTotal: order.grandTotal,
      amountPaidOnline: order.amountPaidOnline,
      balanceDue: money(Math.max(0, order.grandTotal - order.amountPaidOnline)),
    },
    payments: payments.map((p) => ({
      purpose: p.purpose,
      amount: p.capturedAmount ?? p.expectedAmount,
      method: p.method ?? null,
      reference: p.providerPaymentId ?? null,
      at: p.verifiedAt ?? null,
    })),
    gstMode: settings.gstMode,
    note: 'This is a computer-generated invoice.',
  });
}
