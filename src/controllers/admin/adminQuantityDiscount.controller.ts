import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { QuantityDiscountRule } from '../../models/quantityDiscountRule.model';
import { UserQuantityDiscountRule } from '../../models/userQuantityDiscountRule.model';
import { User } from '../../models/user.model';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok, created, noContent } from '../../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/apiError';

/**
 * Quantity-discount ladder administration (spec sections 11-13, 34).
 *
 * Nothing about the tiers is hard-coded - the admin defines `{ minimumQuantity,
 * discountPercentage }` rows at whatever scope they choose and changes them at
 * will (RULE 5, RULE 20). Global/product/category ladders live in one model;
 * per-customer ladders in another. The engine that *applies* them
 * (`quantityDiscount.service`) is separate; this only manages the definitions.
 *
 * RULE 7 - only the single highest qualifying tier ever applies, never a sum -
 * is enforced at resolution time, so nothing here needs to police overlap
 * beyond the unique (scope, minQty) index the models already carry.
 */

function serializeRule(rule: Record<string, unknown>) {
  return {
    id: String(rule._id),
    scope: rule.scope,
    userId: rule.userId ? String(rule.userId) : null,
    productId: rule.productId ? String(rule.productId) : null,
    categoryId: rule.categoryId ? String(rule.categoryId) : null,
    minimumQuantity: rule.minimumQuantity,
    discountPercentage: rule.discountPercentage,
    label: rule.label ?? null,
    status: rule.status,
    startDate: rule.startDate ?? null,
    endDate: rule.endDate ?? null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

async function assertUserExists(userId: string): Promise<void> {
  const exists = await User.exists({ _id: userId });
  if (!exists) throw ApiError.notFound('User not found');
}

// ---------------------------------------------------------------------------
// Global / product / category ladders
// ---------------------------------------------------------------------------

export async function listRules(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  // A userId turns this into a per-customer ladder listing.
  if (query.userId) {
    const filter: Record<string, unknown> = { userId: query.userId };
    if (typeof query.status === 'string') filter.status = query.status;
    if (query.productId) filter.productId = query.productId;
    if (query.categoryId) filter.categoryId = query.categoryId;

    const [rows, total] = await Promise.all([
      UserQuantityDiscountRule.find(filter).sort({ minimumQuantity: 1 }).skip(skip).limit(limit).lean({ virtuals: true }),
      UserQuantityDiscountRule.countDocuments(filter),
    ]);
    paginated(res, rows, page, limit, total);
    return;
  }

  const filter: Record<string, unknown> = {};
  if (typeof query.status === 'string') filter.status = query.status;
  if (query.productId) filter.productId = query.productId;
  if (query.categoryId) filter.categoryId = query.categoryId;
  // scope narrows by which reference is (un)set.
  if (query.scope === 'GLOBAL') Object.assign(filter, { productId: null, categoryId: null });
  else if (query.scope === 'PRODUCT') filter.productId = { $ne: null };
  else if (query.scope === 'CATEGORY') filter.categoryId = { $ne: null };

  const [rows, total] = await Promise.all([
    QuantityDiscountRule.find(filter).sort({ minimumQuantity: 1 }).skip(skip).limit(limit).lean({ virtuals: true }),
    QuantityDiscountRule.countDocuments(filter),
  ]);
  paginated(res, rows, page, limit, total);
}

// Small local wrapper so both branches above read cleanly.
function paginated(res: Response, rows: Record<string, unknown>[], page: number, limit: number, total: number): void {
  ok(res, rows.map(serializeRule), undefined, { pagination: buildPaginationMeta(page, limit, total) });
}

export async function createRule(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const rule = await QuantityDiscountRule.create({ ...req.body, createdBy: actor.userId });
  created(res, serializeRule(rule.toObject({ virtuals: true }) as unknown as Record<string, unknown>), 'Quantity discount rule created');
}

export async function updateRule(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const rule = await QuantityDiscountRule.findById(req.params.id);
  if (!rule) throw ApiError.notFound('Quantity discount rule not found');

  Object.assign(rule, req.body);
  rule.updatedBy = actor.userId;
  await rule.save();
  ok(res, serializeRule(rule.toObject({ virtuals: true }) as unknown as Record<string, unknown>), 'Rule updated');
}

export async function deleteRule(req: Request, res: Response): Promise<void> {
  const deleted = await QuantityDiscountRule.findByIdAndDelete(req.params.id);
  if (!deleted) throw ApiError.notFound('Quantity discount rule not found');
  noContent(res);
}

// ---------------------------------------------------------------------------
// Per-customer ladders
// ---------------------------------------------------------------------------

export async function createUserRule(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const userId = req.params.userId ?? req.body.userId;
  await assertUserExists(String(userId));

  const rule = await UserQuantityDiscountRule.create({ ...req.body, userId, createdBy: actor.userId });
  created(res, serializeRule(rule.toObject({ virtuals: true }) as unknown as Record<string, unknown>), 'Customer quantity discount rule created');
}

export async function updateUserRule(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const filter: Record<string, unknown> = { _id: req.params.id };
  if (req.params.userId) filter.userId = req.params.userId;

  const rule = await UserQuantityDiscountRule.findOne(filter);
  if (!rule) throw ApiError.notFound('Customer quantity discount rule not found');

  Object.assign(rule, req.body);
  rule.updatedBy = actor.userId;
  await rule.save();
  ok(res, serializeRule(rule.toObject({ virtuals: true }) as unknown as Record<string, unknown>), 'Rule updated');
}

export async function deleteUserRule(req: Request, res: Response): Promise<void> {
  const filter: Record<string, unknown> = { _id: req.params.id };
  if (req.params.userId) filter.userId = req.params.userId;
  const deleted = await UserQuantityDiscountRule.findOneAndDelete(filter);
  if (!deleted) throw ApiError.notFound('Customer quantity discount rule not found');
  noContent(res);
}

// ---------------------------------------------------------------------------
// Ladder replace (spec section 34): set a whole tier list for one scope at once
// ---------------------------------------------------------------------------

/**
 * Replaces (or adds to) an entire ladder for a single scope in one call - the
 * "define the 3+/6+/12+ tiers for this product" screen. When `replaceExisting`
 * is true (the default) the scope's current tiers are cleared first, so the
 * saved ladder is exactly the tiers submitted with no stale rows left behind.
 */
export async function setLadder(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const body = req.body as {
    productId?: string;
    categoryId?: string;
    userId?: string;
    tiers: { minimumQuantity: number; discountPercentage: number; label?: string }[];
    replaceExisting?: boolean;
  };

  const isUserScope = Boolean(body.userId);
  if (isUserScope) await assertUserExists(String(body.userId));

  // The exact scope key - all fields must match for a rule to belong to it.
  const scopeFilter: Record<string, Types.ObjectId | null> = {
    productId: body.productId ? new Types.ObjectId(body.productId) : null,
    categoryId: body.categoryId ? new Types.ObjectId(body.categoryId) : null,
  };
  if (isUserScope) scopeFilter.userId = new Types.ObjectId(body.userId);

  // The two ladder models are structurally identical for the two operations
  // used here; a single cast keeps this branch-free without an `any` leak of
  // the returned documents.
  const model = (isUserScope ? UserQuantityDiscountRule : QuantityDiscountRule) as unknown as typeof QuantityDiscountRule;

  if (body.replaceExisting !== false) {
    await model.deleteMany(scopeFilter);
  }

  const docs = body.tiers.map((tier) => ({
    ...scopeFilter,
    minimumQuantity: tier.minimumQuantity,
    discountPercentage: tier.discountPercentage,
    label: tier.label,
    createdBy: actor.userId,
  }));

  // insertMany with ordered:false so a single duplicate tier (when not
  // replacing) does not abort the whole batch.
  const inserted = await model.insertMany(docs, { ordered: false });

  created(
    res,
    { scope: isUserScope ? 'USER' : 'GLOBAL', tiers: inserted.map((d) => serializeRule(d.toObject({ virtuals: true }) as unknown as Record<string, unknown>)) },
    `Ladder saved with ${inserted.length} tier(s)`,
  );
}
