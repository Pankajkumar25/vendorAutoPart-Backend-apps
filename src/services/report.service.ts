import { Types } from 'mongoose';
import { Order } from '../models/order.model';
import { Product } from '../models/product.model';
import { User } from '../models/user.model';
import { Payment } from '../models/payment.model';
import { Coupon } from '../models/coupon.model';
import { UserProductPrice } from '../models/userProductPrice.model';
import {
  ORDER_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PRODUCT_STATUS,
  RECORD_STATUS,
  ROLES,
  TXN_STATUS,
  USER_STATUS,
} from '../config/constants';
import { money } from '../utils/money';

/**
 * Admin dashboard and reports (spec section 26).
 *
 * Revenue counts only orders that reached a state where money is genuinely
 * expected - a PENDING order whose payment never completed is not revenue, and
 * a cancelled one certainly is not. Getting that wrong would make the dashboard
 * flatter itself, which is the one thing a dashboard must not do.
 */

const REVENUE_STATUSES = [
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.PROCESSING,
  ORDER_STATUS.PACKED,
  ORDER_STATUS.SHIPPED,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.DELIVERED,
];

export interface DateRange {
  from?: Date;
  to?: Date;
}

function rangeFilter(range: DateRange = {}): Record<string, unknown> {
  if (!range.from && !range.to) return {};
  const createdAt: Record<string, Date> = {};
  if (range.from) createdAt.$gte = range.from;
  if (range.to) createdAt.$lte = range.to;
  return { createdAt };
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n: number): Date {
  const d = startOfToday();
  d.setDate(d.getDate() - n);
  return d;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDashboard() {
  const today = startOfToday();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);

  const [
    totals,
    todayAgg,
    monthAgg,
    prevMonthAgg,
    statusCounts,
    paymentSplit,
    customerCounts,
    productCounts,
    lowStock,
    outOfStock,
    pendingPayments,
    codPending,
    customPricingCount,
    activeCoupons,
  ] = await Promise.all([
    Order.aggregate<{ _id: null; orders: number; revenue: number }>([
      { $match: { status: { $in: REVENUE_STATUSES } } },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
    ]),
    Order.aggregate<{ _id: null; orders: number; revenue: number }>([
      { $match: { status: { $in: REVENUE_STATUSES }, createdAt: { $gte: today } } },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
    ]),
    Order.aggregate<{ _id: null; orders: number; revenue: number }>([
      { $match: { status: { $in: REVENUE_STATUSES }, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
    ]),
    Order.aggregate<{ _id: null; orders: number; revenue: number }>([
      {
        $match: {
          status: { $in: REVENUE_STATUSES },
          createdAt: { $gte: prevMonthStart, $lt: monthStart },
        },
      },
      { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
    ]),
    Order.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: string; count: number; revenue: number }>([
      { $match: { status: { $in: REVENUE_STATUSES } } },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, revenue: { $sum: '$grandTotal' } } },
    ]),
    User.aggregate<{ _id: string; count: number }>([
      { $match: { role: ROLES.USER } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Product.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Product.countDocuments({
      status: PRODUCT_STATUS.ACTIVE,
      stock: { $gt: 0 },
      $expr: { $lte: ['$stock', '$lowStockThreshold'] },
    }),
    Product.countDocuments({ status: PRODUCT_STATUS.ACTIVE, stock: 0 }),
    Order.countDocuments({ status: ORDER_STATUS.PENDING, paymentStatus: PAYMENT_STATUS.PENDING }),
    Order.aggregate<{ _id: null; count: number; amount: number }>([
      {
        $match: {
          paymentMethod: PAYMENT_METHODS.COD,
          status: { $in: REVENUE_STATUSES, $ne: ORDER_STATUS.DELIVERED },
          remainingCodAmount: { $gt: 0 },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$remainingCodAmount' } } },
    ]),
    UserProductPrice.distinct('userId', { status: RECORD_STATUS.ACTIVE }),
    Coupon.countDocuments({ isActive: true }),
  ]);

  const asMap = (rows: { _id: string; count: number }[]) =>
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r._id]: r.count }), {});

  const monthRevenue = money(monthAgg[0]?.revenue ?? 0);
  const prevMonthRevenue = money(prevMonthAgg[0]?.revenue ?? 0);
  const growth =
    prevMonthRevenue > 0
      ? Number((((monthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100).toFixed(1))
      : null;

  const codRow = codPending[0];
  const onlineSplit = paymentSplit.find((p) => p._id === PAYMENT_METHODS.ONLINE);
  const codSplit = paymentSplit.find((p) => p._id === PAYMENT_METHODS.COD);

  return {
    revenue: {
      total: money(totals[0]?.revenue ?? 0),
      today: money(todayAgg[0]?.revenue ?? 0),
      thisMonth: monthRevenue,
      lastMonth: prevMonthRevenue,
      growthPercent: growth,
    },
    orders: {
      total: totals[0]?.orders ?? 0,
      today: todayAgg[0]?.orders ?? 0,
      thisMonth: monthAgg[0]?.orders ?? 0,
      byStatus: asMap(statusCounts),
      averageOrderValue: totals[0]?.orders
        ? money((totals[0].revenue ?? 0) / totals[0].orders)
        : 0,
    },
    payments: {
      online: { count: onlineSplit?.count ?? 0, revenue: money(onlineSplit?.revenue ?? 0) },
      cod: { count: codSplit?.count ?? 0, revenue: money(codSplit?.revenue ?? 0) },
      awaitingPayment: pendingPayments,
      codOutstanding: { orders: codRow?.count ?? 0, amount: money(codRow?.amount ?? 0) },
    },
    customers: {
      total: Object.values(asMap(customerCounts)).reduce((a, b) => a + b, 0),
      active: asMap(customerCounts)[USER_STATUS.ACTIVE] ?? 0,
      disabled: asMap(customerCounts)[USER_STATUS.DISABLED] ?? 0,
      withCustomPricing: customPricingCount.length,
    },
    catalogue: {
      total: Object.values(asMap(productCounts)).reduce((a, b) => a + b, 0),
      active: asMap(productCounts)[PRODUCT_STATUS.ACTIVE] ?? 0,
      inactive: asMap(productCounts)[PRODUCT_STATUS.INACTIVE] ?? 0,
      lowStock,
      outOfStock,
    },
    coupons: { active: activeCoupons },
  };
}

/** Daily revenue series for the dashboard chart. */
export async function getRevenueSeries(days = 30) {
  const from = daysAgo(days - 1);

  const rows = await Order.aggregate<{ _id: string; revenue: number; orders: number }>([
    { $match: { status: { $in: REVENUE_STATUSES }, createdAt: { $gte: from } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        revenue: { $sum: '$grandTotal' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  // Fill the gaps so the chart has one point per day instead of skipping
  // quiet days, which would otherwise distort the line.
  const byDate = new Map(rows.map((r) => [r._id, r]));
  const series: { date: string; revenue: number; orders: number }[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const row = byDate.get(key);
    series.push({ date: key, revenue: money(row?.revenue ?? 0), orders: row?.orders ?? 0 });
  }
  return series;
}

export async function getTopProducts(limit = 10, range: DateRange = {}) {
  const rows = await Order.aggregate<{
    _id: Types.ObjectId;
    name: string;
    partNumber: string;
    quantity: number;
    revenue: number;
    orders: number;
  }>([
    { $match: { status: { $in: REVENUE_STATUSES }, ...rangeFilter(range) } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.productId',
        name: { $first: '$items.name' },
        partNumber: { $first: '$items.partNumber' },
        quantity: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal' },
        orders: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => ({
    productId: String(r._id),
    name: r.name,
    partNumber: r.partNumber,
    quantitySold: r.quantity,
    revenue: money(r.revenue),
    orderCount: r.orders,
  }));
}

export async function getTopCustomers(limit = 10, range: DateRange = {}) {
  const rows = await Order.aggregate<{
    _id: Types.ObjectId;
    name: string;
    mobile: string;
    orders: number;
    revenue: number;
    lastOrderAt: Date;
  }>([
    { $match: { status: { $in: REVENUE_STATUSES }, ...rangeFilter(range) } },
    {
      $group: {
        _id: '$userId',
        name: { $first: '$customerName' },
        mobile: { $first: '$customerMobile' },
        orders: { $sum: 1 },
        revenue: { $sum: '$grandTotal' },
        lastOrderAt: { $max: '$createdAt' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => ({
    userId: String(r._id),
    name: r.name,
    mobile: r.mobile,
    orderCount: r.orders,
    totalSpent: money(r.revenue),
    averageOrderValue: money(r.revenue / Math.max(1, r.orders)),
    lastOrderAt: r.lastOrderAt,
  }));
}

export async function getCategorySales(range: DateRange = {}) {
  const rows = await Order.aggregate<{
    _id: Types.ObjectId | null;
    quantity: number;
    revenue: number;
  }>([
    { $match: { status: { $in: REVENUE_STATUSES }, ...rangeFilter(range) } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.categoryId',
        quantity: { $sum: '$items.quantity' },
        revenue: { $sum: '$items.lineTotal' },
      },
    },
    { $sort: { revenue: -1 } },
    {
      $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' },
    },
    { $addFields: { name: { $ifNull: [{ $first: '$category.name' }, 'Uncategorised'] } } },
    { $project: { category: 0 } },
  ]);

  return rows.map((r) => ({
    categoryId: r._id ? String(r._id) : null,
    name: (r as unknown as { name: string }).name,
    quantitySold: r.quantity,
    revenue: money(r.revenue),
  }));
}

/** Discount/coupon effectiveness - what the pricing rules actually cost. */
export async function getDiscountReport(range: DateRange = {}) {
  const [totals, byCoupon] = await Promise.all([
    Order.aggregate<{
      _id: null;
      gross: number;
      quantityDiscount: number;
      couponDiscount: number;
      net: number;
      orders: number;
    }>([
      { $match: { status: { $in: REVENUE_STATUSES }, ...rangeFilter(range) } },
      {
        $group: {
          _id: null,
          gross: { $sum: '$itemsGross' },
          quantityDiscount: { $sum: '$quantityDiscountTotal' },
          couponDiscount: { $sum: '$couponDiscount' },
          net: { $sum: '$grandTotal' },
          orders: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate<{ _id: string; uses: number; discount: number; revenue: number }>([
      {
        $match: {
          status: { $in: REVENUE_STATUSES },
          couponCode: { $ne: null },
          ...rangeFilter(range),
        },
      },
      {
        $group: {
          _id: '$couponCode',
          uses: { $sum: 1 },
          discount: { $sum: '$couponDiscount' },
          revenue: { $sum: '$grandTotal' },
        },
      },
      { $sort: { discount: -1 } },
      { $limit: 25 },
    ]),
  ]);

  const t = totals[0];
  const gross = money(t?.gross ?? 0);
  const totalDiscount = money((t?.quantityDiscount ?? 0) + (t?.couponDiscount ?? 0));

  return {
    orders: t?.orders ?? 0,
    grossValue: gross,
    quantityDiscountTotal: money(t?.quantityDiscount ?? 0),
    couponDiscountTotal: money(t?.couponDiscount ?? 0),
    totalDiscount,
    netRevenue: money(t?.net ?? 0),
    discountRatePercent: gross > 0 ? Number(((totalDiscount / gross) * 100).toFixed(2)) : 0,
    coupons: byCoupon.map((c) => ({
      code: c._id,
      uses: c.uses,
      discountGiven: money(c.discount),
      revenueGenerated: money(c.revenue),
    })),
  };
}

/** Payment reconciliation - what the gateway captured vs what COD still owes. */
export async function getPaymentReport(range: DateRange = {}) {
  const [gateway, codOutstanding, failed] = await Promise.all([
    Payment.aggregate<{ _id: string; count: number; amount: number }>([
      { $match: { status: TXN_STATUS.SUCCESS, ...rangeFilter(range) } },
      { $group: { _id: '$purpose', count: { $sum: 1 }, amount: { $sum: '$capturedAmount' } } },
    ]),
    Order.aggregate<{ _id: null; orders: number; amount: number }>([
      {
        $match: {
          paymentMethod: PAYMENT_METHODS.COD,
          status: { $in: REVENUE_STATUSES },
          paymentStatus: { $ne: PAYMENT_STATUS.COD_COLLECTED },
          remainingCodAmount: { $gt: 0 },
          ...rangeFilter(range),
        },
      },
      { $group: { _id: null, orders: { $sum: 1 }, amount: { $sum: '$remainingCodAmount' } } },
    ]),
    Payment.countDocuments({ status: TXN_STATUS.FAILED, ...rangeFilter(range) }),
  ]);

  const full = gateway.find((g) => g._id === 'FULL');
  const advance = gateway.find((g) => g._id === 'COD_ADVANCE');

  return {
    onlineCollected: {
      full: { count: full?.count ?? 0, amount: money(full?.amount ?? 0) },
      codAdvance: { count: advance?.count ?? 0, amount: money(advance?.amount ?? 0) },
      total: money((full?.amount ?? 0) + (advance?.amount ?? 0)),
    },
    codOutstanding: {
      orders: codOutstanding[0]?.orders ?? 0,
      amount: money(codOutstanding[0]?.amount ?? 0),
    },
    failedTransactions: failed,
  };
}

/** Stock report: what to reorder, and how much capital is sitting on shelves. */
export async function getInventoryReport() {
  const [valuation, lowStock, outOfStock, deadStock] = await Promise.all([
    Product.aggregate<{ _id: null; units: number; costValue: number; retailValue: number }>([
      { $match: { status: PRODUCT_STATUS.ACTIVE } },
      {
        $group: {
          _id: null,
          units: { $sum: '$stock' },
          costValue: { $sum: { $multiply: ['$stock', '$basePrice'] } },
          retailValue: { $sum: { $multiply: ['$stock', '$mrp'] } },
        },
      },
    ]),
    Product.find({
      status: PRODUCT_STATUS.ACTIVE,
      stock: { $gt: 0 },
      $expr: { $lte: ['$stock', '$lowStockThreshold'] },
    })
      .select('name partNumber sku stock lowStockThreshold soldCount')
      .sort({ stock: 1 })
      .limit(50)
      .lean(),
    Product.find({ status: PRODUCT_STATUS.ACTIVE, stock: 0 })
      .select('name partNumber sku soldCount')
      .limit(50)
      .lean(),
    // Sitting in stock, never sold - capital that is not working.
    Product.find({ status: PRODUCT_STATUS.ACTIVE, soldCount: 0, stock: { $gt: 0 } })
      .select('name partNumber stock basePrice createdAt')
      .sort({ createdAt: 1 })
      .limit(25)
      .lean(),
  ]);

  const v = valuation[0];
  return {
    valuation: {
      units: v?.units ?? 0,
      atCost: money(v?.costValue ?? 0),
      atMrp: money(v?.retailValue ?? 0),
    },
    lowStock: lowStock.map((p) => ({
      productId: String(p._id),
      name: p.name,
      partNumber: p.partNumber,
      sku: p.sku,
      stock: p.stock,
      threshold: p.lowStockThreshold,
      soldCount: p.soldCount,
    })),
    outOfStock: outOfStock.map((p) => ({
      productId: String(p._id),
      name: p.name,
      partNumber: p.partNumber,
      sku: p.sku,
      soldCount: p.soldCount,
    })),
    deadStock: deadStock.map((p) => ({
      productId: String(p._id),
      name: p.name,
      partNumber: p.partNumber,
      stock: p.stock,
      valueAtCost: money(p.stock * p.basePrice),
      addedOn: p.createdAt,
    })),
  };
}

/** GST summary per rate - what an accountant needs at filing time. */
export async function getTaxReport(range: DateRange = {}) {
  const rows = await Order.aggregate<{ _id: number; taxable: number; tax: number; orders: number }>([
    { $match: { status: { $in: REVENUE_STATUSES }, ...rangeFilter(range) } },
    { $unwind: '$items' },
    {
      $group: {
        _id: '$items.gstRate',
        taxable: { $sum: '$items.taxableAmount' },
        tax: { $sum: '$items.gstAmount' },
        orders: { $addToSet: '$_id' },
      },
    },
    { $addFields: { orders: { $size: '$orders' } } },
    { $sort: { _id: 1 } },
  ]);

  return {
    byRate: rows.map((r) => ({
      gstRate: r._id,
      taxableValue: money(r.taxable),
      taxAmount: money(r.tax),
      // Intra-state split. Inter-state (IGST) would be the same total under a
      // single head; the split is presentational.
      cgst: money(r.tax / 2),
      sgst: money(r.tax / 2),
      orderCount: r.orders,
    })),
    totalTaxableValue: money(rows.reduce((sum, r) => sum + r.taxable, 0)),
    totalTax: money(rows.reduce((sum, r) => sum + r.tax, 0)),
  };
}

/** Flat rows for a CSV export of orders. */
export async function getSalesExportRows(range: DateRange = {}) {
  const orders = await Order.find({ ...rangeFilter(range) })
    .select(
      'orderNumber createdAt customerName customerMobile status paymentMethod paymentStatus ' +
        'itemsGross quantityDiscountTotal couponCode couponDiscount gstTotal deliveryCharge ' +
        'grandTotal amountPaidOnline remainingCodAmount address.city address.pincode',
    )
    .sort({ createdAt: -1 })
    .limit(5000)
    .lean();

  return orders.map((o) => ({
    orderNumber: o.orderNumber,
    date: o.createdAt.toISOString().slice(0, 10),
    customer: o.customerName,
    mobile: o.customerMobile,
    city: o.address?.city ?? '',
    pincode: o.address?.pincode ?? '',
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    gross: o.itemsGross,
    quantityDiscount: o.quantityDiscountTotal,
    coupon: o.couponCode ?? '',
    couponDiscount: o.couponDiscount,
    gst: o.gstTotal,
    delivery: o.deliveryCharge,
    total: o.grandTotal,
    paidOnline: o.amountPaidOnline,
    codDue: o.remainingCodAmount,
  }));
}

/** Minimal CSV serialiser - quotes fields and escapes embedded quotes. */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ].join('\n');
}
