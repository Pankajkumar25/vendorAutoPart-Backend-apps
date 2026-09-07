import type { Request, Response } from 'express';
import { Order, type IOrder } from '../../models/order.model';
import { Payment } from '../../models/payment.model';
import * as orderService from '../../services/order.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok, paginated } from '../../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/apiError';
import { escapeRegex } from '../../utils/slug';
import { ROLES } from '../../config/constants';

/**
 * Order administration (spec sections 24, 25, 27).
 *
 * Every money-moving action here delegates to `order.service`, which recomputes
 * and validates - status transitions are checked against the allowed flow, COD
 * collection cannot exceed the balance, and refunds cannot exceed what the
 * gateway actually captured. This controller only marshals input and shapes the
 * reply; it never does arithmetic on a total (RULES 14-16).
 */

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  total_desc: { grandTotal: -1 },
  total_asc: { grandTotal: 1 },
};

function toAdminDetail(order: IOrder) {
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    customer: {
      id: String(order.userId),
      name: order.customerName,
      mobile: order.customerMobile,
    },
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
      unitPrice: item.effectiveUnitPrice,
      userPrice: item.userPrice,
      hasCustomPrice: item.userPrice !== null,
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
      changedByRole: event.changedByRole ?? null,
      at: event.at,
    })),
    trackingNumber: order.trackingNumber ?? null,
    courierName: order.courierName ?? null,
    estimatedDeliveryDate: order.estimatedDeliveryDate ?? null,
    deliveredAt: order.deliveredAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    cancelReason: order.cancelReason ?? null,
    cancelledByRole: order.cancelledByRole ?? null,
    returnReason: order.returnReason ?? null,
    customerNote: order.customerNote ?? null,
    adminNote: order.adminNote ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export async function listOrders(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = {};
  if (typeof query.status === 'string') filter.status = query.status;
  if (typeof query.paymentMethod === 'string') filter.paymentMethod = query.paymentMethod;
  if (typeof query.paymentStatus === 'string') filter.paymentStatus = query.paymentStatus;
  if (query.userId) filter.userId = query.userId;

  if (typeof query.q === 'string' && query.q.trim()) {
    const rx = escapeRegex(query.q.trim());
    filter.$or = [
      { orderNumber: new RegExp(rx, 'i') },
      { customerName: new RegExp(rx, 'i') },
      { customerMobile: new RegExp(rx, 'i') },
    ];
  }

  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = new Date(String(query.from));
    if (query.to) range.$lte = new Date(String(query.to));
    filter.createdAt = range;
  }
  if (query.minTotal !== undefined || query.maxTotal !== undefined) {
    const range: Record<string, number> = {};
    if (query.minTotal !== undefined) range.$gte = Number(query.minTotal);
    if (query.maxTotal !== undefined) range.$lte = Number(query.maxTotal);
    filter.grandTotal = range;
  }

  const sort = SORTS[String(query.sort ?? 'newest')] ?? SORTS.newest;

  const [orders, total] = await Promise.all([
    Order.find(filter).sort(sort).skip(skip).limit(limit).lean<IOrder[]>(),
    Order.countDocuments(filter),
  ]);

  const items = orders.map((order) => ({
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName,
    customerMobile: order.customerMobile,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    grandTotal: order.grandTotal,
    remainingCodAmount: order.remainingCodAmount,
    amountPaidOnline: order.amountPaidOnline,
    itemCount: order.items.length,
    totalQuantity: order.items.reduce((sum, item) => sum + item.quantity, 0),
    createdAt: order.createdAt,
  }));

  paginated(res, items, buildPaginationMeta(page, limit, total));
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');

  // The transaction trail is admin-only detail - the customer detail view omits it.
  const payments = await Payment.find({ orderId: order._id })
    .select('purpose provider status expectedAmount capturedAmount refundedAmount refundId method providerPaymentId verifiedAt createdAt failureReason')
    .sort({ createdAt: 1 })
    .lean();

  ok(res, {
    ...toAdminDetail(order),
    payments: payments.map((p) => ({
      id: String(p._id),
      purpose: p.purpose,
      provider: p.provider,
      status: p.status,
      expectedAmount: p.expectedAmount,
      capturedAmount: p.capturedAmount ?? null,
      refundedAmount: p.refundedAmount ?? 0,
      refundId: p.refundId ?? null,
      method: p.method ?? null,
      reference: p.providerPaymentId ?? null,
      failureReason: p.failureReason ?? null,
      verifiedAt: p.verifiedAt ?? null,
      createdAt: p.createdAt,
    })),
  });
}

/** Advance the order along the fulfilment flow (spec section 25). */
export async function updateStatus(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const body = req.body as { status: string; note?: string; trackingNumber?: string; courierName?: string };

  const order = await orderService.updateOrderStatus({
    orderId: req.params.id,
    status: body.status as never,
    note: body.note,
    trackingNumber: body.trackingNumber,
    courierName: body.courierName,
    actorId: actor.userId,
    actorRole: ROLES.ADMIN,
  });

  ok(res, toAdminDetail(order), `Order marked ${order.status}`);
}

/** Record cash received against a COD order (spec section 23). */
export async function recordCodCollection(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const body = req.body as { amount?: number; note?: string };

  const order = await orderService.recordCodCollection({
    orderId: req.params.id,
    amount: body.amount,
    note: body.note,
    actorId: actor.userId,
  });

  ok(res, toAdminDetail(order), 'Cash collection recorded');
}

/**
 * Refund an online payment (spec section 27). The amount is optional - omit it
 * for a full refund of whatever remains refundable. The service caps it at the
 * gateway-captured amount, so an over-refund is impossible even if requested.
 */
export async function refund(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const body = req.body as { amount?: number; reason: string };

  const result = await orderService.refundOrderPayment({
    orderId: req.params.id,
    amount: body.amount,
    reason: body.reason,
    actorId: actor.userId,
  });

  ok(
    res,
    { order: toAdminDetail(result.order), refundId: result.refundId, refundedAmount: result.amount },
    'Refund processed',
  );
}
