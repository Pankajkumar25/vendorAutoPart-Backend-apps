import { Types } from 'mongoose';
import { UserProductPrice, type IUserProductPrice } from '../models/userProductPrice.model';
import { Product } from '../models/product.model';
import { RECORD_STATUS } from '../config/constants';
import { ApiError } from '../utils/apiError';
import { money } from '../utils/money';

/**
 * Customer-specific price lookups (spec sections 8-10).
 *
 * The only rule that matters here: an ACTIVE UserProductPrice row wins over
 * `product.basePrice`; anything else falls back to the base price. An INACTIVE
 * row is treated exactly like no row at all, which is what lets an admin
 * temporarily suspend a negotiated rate without losing it.
 */

export interface ResolvedUserPrice {
  /** The price the customer will actually be charged per unit. */
  effectiveUnitPrice: number;
  /** The product default. */
  basePrice: number;
  /** The custom price if one applied, otherwise null. */
  userPrice: number | null;
  hasCustomPrice: boolean;
}

const toId = (value: string | Types.ObjectId): Types.ObjectId =>
  value instanceof Types.ObjectId ? value : new Types.ObjectId(value);

/**
 * Bulk-loads the custom prices for one customer across many products.
 * Returns a map keyed by product id string.
 *
 * Bulk is the default because the alternative - one query per cart line - turns
 * a 20-item cart into 20 round trips on every price recalculation.
 */
export async function getUserPriceMap(
  userId: string | Types.ObjectId,
  productIds: (string | Types.ObjectId)[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!productIds.length) return map;

  const rows = await UserProductPrice.find({
    userId: toId(userId),
    productId: { $in: productIds.map(toId) },
    status: RECORD_STATUS.ACTIVE,
  })
    .select('productId customPrice')
    .lean();

  for (const row of rows) map.set(String(row.productId), row.customPrice);
  return map;
}

/** Single-product variant of {@link getUserPriceMap}. */
export async function getUserPrice(
  userId: string | Types.ObjectId,
  productId: string | Types.ObjectId,
): Promise<number | null> {
  const row = await UserProductPrice.findOne({
    userId: toId(userId),
    productId: toId(productId),
    status: RECORD_STATUS.ACTIVE,
  })
    .select('customPrice')
    .lean();
  return row ? row.customPrice : null;
}

/**
 * Implements the price priority of spec section 10:
 *   base price -> overridden by user-specific price when present.
 */
export function resolveEffectiveUnitPrice(basePrice: number, userPrice: number | null): ResolvedUserPrice {
  const hasCustomPrice = userPrice !== null && userPrice !== undefined && Number.isFinite(userPrice);
  return {
    basePrice: money(basePrice),
    userPrice: hasCustomPrice ? money(userPrice as number) : null,
    effectiveUnitPrice: money(hasCustomPrice ? (userPrice as number) : basePrice),
    hasCustomPrice,
  };
}

// ---------------------------------------------------------------------------
// Admin write operations (spec section 9)
// ---------------------------------------------------------------------------

export interface UpsertUserPriceInput {
  userId: string;
  productId: string;
  customPrice: number;
  status?: keyof typeof RECORD_STATUS;
  note?: string;
  actorId?: string;
}

/**
 * Creates or updates the single (userId, productId) row. Uses an upsert so two
 * admins saving at once cannot create a duplicate that violates the unique
 * index.
 */
export async function upsertUserProductPrice(input: UpsertUserPriceInput): Promise<IUserProductPrice> {
  const product = await Product.findById(input.productId).select('basePrice mrp name').lean();
  if (!product) throw ApiError.notFound('Product not found');

  if (input.customPrice < 0) throw ApiError.validation('Custom price cannot be negative');

  const row = await UserProductPrice.findOneAndUpdate(
    { userId: toId(input.userId), productId: toId(input.productId) },
    {
      $set: {
        customPrice: money(input.customPrice),
        status: input.status ?? RECORD_STATUS.ACTIVE,
        note: input.note,
        basePriceAtAssignment: product.basePrice,
        updatedBy: input.actorId ? toId(input.actorId) : undefined,
      },
      $setOnInsert: {
        userId: toId(input.userId),
        productId: toId(input.productId),
        createdBy: input.actorId ? toId(input.actorId) : undefined,
      },
    },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );

  return row;
}

/**
 * Applies many custom prices for one customer in a single round trip - the
 * bulk-paste workflow on the admin pricing screen.
 */
export async function bulkUpsertUserProductPrices(
  userId: string,
  entries: { productId: string; customPrice: number; status?: keyof typeof RECORD_STATUS }[],
  actorId?: string,
): Promise<{ matched: number; upserted: number }> {
  if (!entries.length) return { matched: 0, upserted: 0 };

  const productIds = entries.map((e) => toId(e.productId));
  const existing = await Product.find({ _id: { $in: productIds } })
    .select('_id basePrice')
    .lean();
  const baseById = new Map(existing.map((p) => [String(p._id), p.basePrice]));

  const missing = entries.filter((e) => !baseById.has(String(e.productId)));
  if (missing.length) {
    throw ApiError.validation('Some products could not be found', {
      missingProductIds: missing.map((m) => m.productId),
    });
  }

  const ops = entries.map((entry) => ({
    updateOne: {
      filter: { userId: toId(userId), productId: toId(entry.productId) },
      update: {
        $set: {
          customPrice: money(entry.customPrice),
          status: entry.status ?? RECORD_STATUS.ACTIVE,
          basePriceAtAssignment: baseById.get(String(entry.productId)),
          updatedBy: actorId ? toId(actorId) : undefined,
        },
        $setOnInsert: {
          userId: toId(userId),
          productId: toId(entry.productId),
          createdBy: actorId ? toId(actorId) : undefined,
        },
      },
      upsert: true,
    },
  }));

  const result = await UserProductPrice.bulkWrite(ops, { ordered: false });
  return { matched: result.modifiedCount ?? 0, upserted: result.upsertedCount ?? 0 };
}

export async function deleteUserProductPrice(userId: string, productId: string): Promise<boolean> {
  const res = await UserProductPrice.deleteOne({ userId: toId(userId), productId: toId(productId) });
  return res.deletedCount > 0;
}

export async function setUserProductPriceStatus(
  id: string,
  status: keyof typeof RECORD_STATUS,
  actorId?: string,
): Promise<IUserProductPrice> {
  const row = await UserProductPrice.findByIdAndUpdate(
    id,
    { $set: { status, updatedBy: actorId ? toId(actorId) : undefined } },
    { new: true },
  );
  if (!row) throw ApiError.notFound('Custom price not found');
  return row;
}

/** Which of these customers has a custom price? Powers the admin user list. */
export async function getUsersWithCustomPricing(userIds: (string | Types.ObjectId)[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await UserProductPrice.aggregate<{ _id: Types.ObjectId }>([
    { $match: { userId: { $in: userIds.map(toId) }, status: RECORD_STATUS.ACTIVE } },
    { $group: { _id: '$userId' } },
  ]);
  return new Set(rows.map((r) => String(r._id)));
}
