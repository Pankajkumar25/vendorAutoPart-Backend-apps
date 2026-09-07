import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { User } from '../../models/user.model';
import { Product } from '../../models/product.model';
import { UserProductPrice } from '../../models/userProductPrice.model';
import {
  upsertUserProductPrice,
  bulkUpsertUserProductPrices,
  deleteUserProductPrice,
} from '../../services/userPricing.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok, created, noContent, paginated } from '../../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/apiError';
import { escapeRegex } from '../../utils/slug';
import { money } from '../../utils/money';
import { PRODUCT_STATUS, RECORD_STATUS } from '../../config/constants';

/**
 * Customer-specific pricing (spec sections 8-10). This is the feature the whole
 * app exists for: the same product can carry a different price for every dealer.
 *
 * The writes go through `userPricing.service` so the unique (userId, productId)
 * invariant and base-price snapshot are enforced in one place. A customer's
 * negotiated prices are only ever addressed by *their* userId in the route -
 * one dealer's pricing is never reachable from another's endpoint (RULES 18, 19).
 */

async function assertUserExists(userId: string): Promise<void> {
  const exists = await User.exists({ _id: userId });
  if (!exists) throw ApiError.notFound('User not found');
}

/** List one customer's custom prices, decorated with live product context. */
export async function listUserPrices(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;
  await assertUserExists(userId);

  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = { userId: new Types.ObjectId(userId) };
  if (typeof query.status === 'string') filter.status = query.status;

  // A text search is a filter on the *product*, resolved to ids first.
  if (typeof query.q === 'string' && query.q.trim()) {
    const rx = new RegExp(escapeRegex(query.q.trim()), 'i');
    const matched = await Product.find({ $or: [{ name: rx }, { sku: rx }, { partNumber: rx }] })
      .select('_id')
      .lean();
    filter.productId = { $in: matched.map((p) => p._id) };
  }

  const [rows, total] = await Promise.all([
    UserProductPrice.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    UserProductPrice.countDocuments(filter),
  ]);

  const products = await Product.find({ _id: { $in: rows.map((r) => r.productId) } })
    .select('name sku partNumber basePrice mrp images status')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = rows.map((row) => {
    const product = byId.get(String(row.productId));
    return {
      productId: String(row.productId),
      customPrice: row.customPrice,
      status: row.status,
      note: row.note ?? null,
      basePriceAtAssignment: row.basePriceAtAssignment ?? null,
      currentBasePrice: product?.basePrice ?? null,
      // Flag rows whose base price moved since assignment, so the admin can
      // spot a negotiated price that has drifted from the catalogue.
      basePriceChanged:
        product != null && row.basePriceAtAssignment != null && product.basePrice !== row.basePriceAtAssignment,
      product: product
        ? {
            id: String(product._id),
            name: product.name,
            sku: product.sku,
            partNumber: product.partNumber,
            mrp: product.mrp,
            image: product.images?.find((i) => i.isPrimary)?.url ?? product.images?.[0]?.url ?? null,
            status: product.status,
          }
        : null,
      updatedAt: row.updatedAt,
    };
  });

  paginated(res, items, buildPaginationMeta(page, limit, total));
}

/** Create or update a single custom price. */
export async function setUserPrice(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const { userId } = req.params;
  await assertUserExists(userId);

  const body = req.body as { productId: string; customPrice: number; note?: string; status?: keyof typeof RECORD_STATUS };
  const row = await upsertUserProductPrice({
    userId,
    productId: body.productId,
    customPrice: body.customPrice,
    note: body.note,
    status: body.status,
    actorId: String(actor.userId),
  });

  created(res, {
    productId: String(row.productId),
    customPrice: row.customPrice,
    status: row.status,
    note: row.note ?? null,
  }, 'Custom price saved');
}

/** Bulk paste: many custom prices for one customer in a single call. */
export async function bulkSetUserPrices(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const { userId } = req.params;
  await assertUserExists(userId);

  const body = req.body as { entries: { productId: string; customPrice: number; note?: string }[] };
  const result = await bulkUpsertUserProductPrices(userId, body.entries, String(actor.userId));

  ok(res, result, `Saved ${result.matched + result.upserted} custom price(s)`);
}

export async function deleteUserPrice(req: Request, res: Response): Promise<void> {
  const { userId, productId } = req.params;
  const removed = await deleteUserProductPrice(userId, productId);
  if (!removed) throw ApiError.notFound('That customer has no custom price for this product');
  noContent(res);
}

/**
 * Bulk-generate custom prices from a rule (spec section 9): "give this customer
 * 10% off every product in the Brakes category". The engine here is deliberately
 * simple and explicit - it derives each price from the *current* base price and
 * writes concrete per-product rows, so the result is auditable and does not
 * silently re-drift when a base price later changes.
 */
export async function applyPricingRule(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const { userId } = req.params;
  await assertUserExists(userId);

  const body = req.body as {
    discountPercentage?: number;
    reduceBy?: number;
    categoryId?: string;
    productIds?: string[];
    overwriteExisting?: boolean;
    note?: string;
  };

  // Resolve the target set. The validator guarantees exactly one of categoryId
  // / productIds is present.
  const productFilter: Record<string, unknown> = { status: PRODUCT_STATUS.ACTIVE };
  if (body.productIds?.length) productFilter._id = { $in: body.productIds };
  else if (body.categoryId) productFilter.category = body.categoryId;

  const products = await Product.find(productFilter).select('_id basePrice').lean();
  if (!products.length) throw ApiError.badRequest('No matching products to price');

  // When not overwriting, leave any product the customer already has a rule for
  // untouched.
  let skipIds = new Set<string>();
  if (!body.overwriteExisting) {
    const existing = await UserProductPrice.find({ userId: new Types.ObjectId(userId) })
      .select('productId')
      .lean();
    skipIds = new Set(existing.map((r) => String(r.productId)));
  }

  const entries: { productId: string; customPrice: number; note?: string }[] = [];
  let skipped = 0;
  for (const product of products) {
    if (skipIds.has(String(product._id))) {
      skipped += 1;
      continue;
    }
    const custom =
      body.discountPercentage !== undefined
        ? money(product.basePrice * (1 - body.discountPercentage / 100))
        : money(Math.max(0, product.basePrice - (body.reduceBy ?? 0)));
    entries.push({ productId: String(product._id), customPrice: Math.max(0, custom), note: body.note });
  }

  const result = entries.length
    ? await bulkUpsertUserProductPrices(userId, entries, String(actor.userId))
    : { matched: 0, upserted: 0 };

  ok(
    res,
    { applied: entries.length, skipped, matched: result.matched, upserted: result.upserted },
    `Applied pricing to ${entries.length} product(s)`,
  );
}

/**
 * Clone one customer's entire custom-price list onto another (spec section 9) -
 * the "new dealer, same deal as Raj Traders" workflow.
 */
export async function copyPricing(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const { userId } = req.params;
  const body = req.body as { fromUserId: string; overwriteExisting?: boolean };

  if (body.fromUserId === userId) throw ApiError.badRequest('Source and destination customers are the same');
  await Promise.all([assertUserExists(userId), assertUserExists(body.fromUserId)]);

  const source = await UserProductPrice.find({
    userId: new Types.ObjectId(body.fromUserId),
    status: RECORD_STATUS.ACTIVE,
  })
    .select('productId customPrice note')
    .lean();
  if (!source.length) throw ApiError.badRequest('The source customer has no custom prices to copy');

  let skipIds = new Set<string>();
  if (!body.overwriteExisting) {
    const existing = await UserProductPrice.find({ userId: new Types.ObjectId(userId) })
      .select('productId')
      .lean();
    skipIds = new Set(existing.map((r) => String(r.productId)));
  }

  const entries = source
    .filter((row) => !skipIds.has(String(row.productId)))
    .map((row) => ({ productId: String(row.productId), customPrice: row.customPrice, note: row.note }));

  const result = entries.length
    ? await bulkUpsertUserProductPrices(userId, entries, String(actor.userId))
    : { matched: 0, upserted: 0 };

  ok(
    res,
    { copied: entries.length, skipped: source.length - entries.length, ...result },
    `Copied ${entries.length} custom price(s)`,
  );
}
