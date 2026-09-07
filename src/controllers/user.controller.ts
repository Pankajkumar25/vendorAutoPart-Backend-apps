import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { Order } from '../models/order.model';
import { UserProductPrice } from '../models/userProductPrice.model';
import { UserQuantityDiscountRule } from '../models/userQuantityDiscountRule.model';
import { requireAuth } from '../middleware/auth.middleware';
import { publicUser } from '../services/auth.service';
import { ok } from '../utils/apiResponse';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { money } from '../utils/money';
import { buildPaginationMeta, parsePagination } from '../utils/pagination';
import { paginated } from '../utils/apiResponse';
import { ORDER_STATUS, RECORD_STATUS } from '../config/constants';

/**
 * The signed-in customer's own account.
 *
 * Every query here is scoped by `auth.userId`, taken from the verified token.
 * There is no route in this file that accepts a user id from the client, which
 * is what makes RULES 18/19 structurally true: a customer cannot ask for
 * somebody else's pricing because there is nowhere to put the other id.
 */

export async function getProfile(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const user = await User.findById(auth.userId);
  if (!user) throw ApiError.notFound('Account not found');
  ok(res, publicUser(user));
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const user = await User.findById(auth.userId);
  if (!user) throw ApiError.notFound('Account not found');

  const { name, businessName, gstNumber, email, mobile } = req.body as Record<string, string | undefined>;

  // Changing a login identifier has to stay unique across the whole store.
  if ((email && email !== user.email) || (mobile && mobile !== user.mobile)) {
    const clash = await User.findOne({
      _id: { $ne: user._id },
      $or: [...(email ? [{ email }] : []), ...(mobile ? [{ mobile }] : [])],
    })
      .select('email mobile')
      .lean();
    if (clash) {
      throw new ApiError(
        409,
        clash.email === email
          ? 'That email is already in use'
          : 'That mobile number is already in use',
        ERROR_CODES.DUPLICATE_ENTRY,
        { field: clash.email === email ? 'email' : 'mobile' },
      );
    }
  }

  if (name !== undefined) user.name = name;
  if (businessName !== undefined) user.businessName = businessName || undefined;
  if (gstNumber !== undefined) user.gstNumber = gstNumber || undefined;
  if (email !== undefined && email) {
    user.email = email;
    user.emailVerifiedAt = undefined;
  }
  if (mobile !== undefined && mobile) {
    user.mobile = mobile;
    user.mobileVerifiedAt = undefined;
  }

  await user.save();
  ok(res, publicUser(user), 'Profile updated');
}

/**
 * "My account" summary for the profile tab: order counts, lifetime spend and
 * whether this customer has negotiated pricing.
 */
export async function getAccountSummary(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const [statusRows, spend, customPrices, customRules] = await Promise.all([
    Order.aggregate<{ _id: string; count: number }>([
      { $match: { userId: auth.userId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Order.aggregate<{ _id: null; total: number; savings: number; orders: number }>([
      {
        $match: {
          userId: auth.userId,
          status: { $nin: [ORDER_STATUS.PENDING, ORDER_STATUS.CANCELLED] },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$grandTotal' },
          savings: { $sum: '$totalSavings' },
          orders: { $sum: 1 },
        },
      },
    ]),
    UserProductPrice.countDocuments({ userId: auth.userId, status: RECORD_STATUS.ACTIVE }),
    UserQuantityDiscountRule.countDocuments({ userId: auth.userId, status: RECORD_STATUS.ACTIVE }),
  ]);

  const byStatus = statusRows.reduce<Record<string, number>>(
    (acc, row) => ({ ...acc, [row._id]: row.count }),
    {},
  );
  const totals = spend[0];

  ok(res, {
    orders: {
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      active: (byStatus[ORDER_STATUS.CONFIRMED] ?? 0) +
        (byStatus[ORDER_STATUS.PROCESSING] ?? 0) +
        (byStatus[ORDER_STATUS.PACKED] ?? 0) +
        (byStatus[ORDER_STATUS.SHIPPED] ?? 0) +
        (byStatus[ORDER_STATUS.OUT_FOR_DELIVERY] ?? 0),
      delivered: byStatus[ORDER_STATUS.DELIVERED] ?? 0,
      awaitingPayment: byStatus[ORDER_STATUS.PENDING] ?? 0,
    },
    spend: {
      lifetime: money(totals?.total ?? 0),
      totalSavings: money(totals?.savings ?? 0),
      averageOrderValue: totals?.orders ? money(totals.total / totals.orders) : 0,
    },
    pricing: {
      hasCustomPricing: customPrices > 0,
      customPricedProducts: customPrices,
      customQuantityRules: customRules,
    },
  });
}

/**
 * The customer's own negotiated price list.
 *
 * This is the one place a UserProductPrice row is ever returned to a
 * non-admin, and it is filtered to `userId` from the token. `basePriceAtAssignment`
 * and the admin's internal note are deliberately not projected - the customer
 * sees their price, not the store's workings.
 */
export async function getMyPricing(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

  const filter = { userId: auth.userId, status: RECORD_STATUS.ACTIVE };

  const [rows, total] = await Promise.all([
    UserProductPrice.find(filter)
      .select('productId customPrice updatedAt')
      .populate<{ productId: { _id: Types.ObjectId; name: string; partNumber: string; sku: string; mrp: number; basePrice: number; images: { url: string }[]; unit: string } }>(
        'productId',
        'name partNumber sku mrp basePrice images unit',
      )
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    UserProductPrice.countDocuments(filter),
  ]);

  const items = rows
    .filter((row) => row.productId)
    .map((row) => {
      const product = row.productId as unknown as {
        _id: Types.ObjectId;
        name: string;
        partNumber: string;
        sku: string;
        mrp: number;
        basePrice: number;
        images?: { url: string }[];
        unit?: string;
      };
      return {
        productId: String(product._id),
        name: product.name,
        partNumber: product.partNumber,
        sku: product.sku,
        image: product.images?.[0]?.url ?? null,
        unit: product.unit ?? 'PCS',
        mrp: money(product.mrp),
        listPrice: money(product.basePrice),
        yourPrice: money(row.customPrice),
        savingsVsList: money(Math.max(0, product.basePrice - row.customPrice)),
        updatedAt: row.updatedAt,
      };
    });

  paginated(res, items, buildPaginationMeta(page, limit, total));
}

/** The customer's own quantity-discount ladders, for the "your slabs" screen. */
export async function getMyQuantityDiscounts(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);

  const rules = await UserQuantityDiscountRule.find({
    userId: auth.userId,
    status: RECORD_STATUS.ACTIVE,
    $and: [
      { $or: [{ startDate: null }, { startDate: { $lte: new Date() } }] },
      { $or: [{ endDate: null }, { endDate: { $gt: new Date() } }] },
    ],
  })
    .select('productId categoryId minimumQuantity discountPercentage label')
    .populate('productId', 'name partNumber')
    .populate('categoryId', 'name')
    .sort({ minimumQuantity: 1 })
    .lean();

  ok(
    res,
    rules.map((rule) => {
      const product = rule.productId as unknown as { _id: Types.ObjectId; name: string; partNumber: string } | null;
      const category = rule.categoryId as unknown as { _id: Types.ObjectId; name: string } | null;
      return {
        id: String(rule._id),
        appliesTo: product
          ? { type: 'PRODUCT', id: String(product._id), name: product.name, partNumber: product.partNumber }
          : category
            ? { type: 'CATEGORY', id: String(category._id), name: category.name }
            : { type: 'ALL', id: null, name: 'All products' },
        minimumQuantity: rule.minimumQuantity,
        discountPercentage: rule.discountPercentage,
        label: rule.label ?? null,
      };
    }),
  );
}
