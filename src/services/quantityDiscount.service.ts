import { Types } from 'mongoose';
import { QuantityDiscountRule, type IQuantityDiscountRule } from '../models/quantityDiscountRule.model';
import {
  UserQuantityDiscountRule,
  type IUserQuantityDiscountRule,
} from '../models/userQuantityDiscountRule.model';
import {
  QTY_DISCOUNT_RESOLUTION,
  QTY_DISCOUNT_SCOPES,
  RECORD_STATUS,
  type QtyDiscountResolution,
  type QtyDiscountScope,
} from '../config/constants';
import { clampPercent } from '../utils/money';

/**
 * Quantity-discount resolution (spec sections 11-13, 40).
 *
 * Two independent decisions live here and it is worth keeping them apart:
 *
 *   1. WHICH SCOPE'S LADDER APPLIES. Precedence is most-specific-first:
 *      user+product > user+category > user-global > product > category > global.
 *
 *   2. WHICH TIER INSIDE THAT LADDER APPLIES. Only the single highest
 *      qualifying tier is used - never the sum (RULE 7). With `3+ = 2%` and
 *      `6+ = 6%`, a quantity of 6 gets 6%, not 8%.
 *
 * For (1) the admin picks the semantics via `settings.quantityDiscountResolution`:
 *
 *   SCOPE_OVERRIDE (default, and the literal reading of the spec's
 *     "if a user-specific quantity discount exists, use that rule"):
 *     the most specific scope holding *any* active rule wins outright. If Raj
 *     has a bespoke ladder that starts at 6+, buying 3 gets him nothing - his
 *     ladder replaces the global one rather than layering on top of it.
 *
 *   BEST_APPLICABLE: every scope is considered together and the highest
 *     qualifying percentage wins regardless of where it came from. Choose this
 *     if user rules should be a floor rather than a replacement.
 */

export interface DiscountRuleTier {
  ruleId: Types.ObjectId | null;
  scope: QtyDiscountScope;
  minimumQuantity: number;
  discountPercentage: number;
  label?: string | null;
}

export interface ResolvedQuantityDiscount {
  /** Percentage to apply. 0 when nothing qualifies. */
  discountPercentage: number;
  scope: QtyDiscountScope | null;
  ruleId: Types.ObjectId | null;
  minimumQuantity: number | null;
  label?: string | null;
  /** The ladder that was in force, for "buy 6+ and get 6% off" messaging. */
  activeLadder: DiscountRuleTier[];
  /** Next tier the customer has not reached yet, for cart upsell hints. */
  nextTier: DiscountRuleTier | null;
}

export interface ProductScopeRef {
  productId: string | Types.ObjectId;
  categoryId?: string | Types.ObjectId | null;
}

/**
 * All rules relevant to one customer and one set of products, loaded in two
 * queries regardless of cart size.
 */
export interface DiscountRuleContext {
  userTiers: DiscountRuleTier[];
  globalTiers: DiscountRuleTier[];
  resolution: QtyDiscountResolution;
}

const toId = (value: string | Types.ObjectId): Types.ObjectId =>
  value instanceof Types.ObjectId ? value : new Types.ObjectId(value);

/** A rule is live only if its optional date window contains `now`. */
function isWithinWindow(rule: { startDate?: Date | null; endDate?: Date | null }, now: Date): boolean {
  if (rule.startDate && rule.startDate.getTime() > now.getTime()) return false;
  if (rule.endDate && rule.endDate.getTime() <= now.getTime()) return false;
  return true;
}

function userScopeOf(rule: IUserQuantityDiscountRule): QtyDiscountScope {
  if (rule.productId) return 'USER_PRODUCT';
  if (rule.categoryId) return 'USER_CATEGORY';
  return 'USER_GLOBAL';
}

function globalScopeOf(rule: IQuantityDiscountRule): QtyDiscountScope {
  if (rule.productId) return 'PRODUCT';
  if (rule.categoryId) return 'CATEGORY';
  return 'GLOBAL';
}

/** Tiers carry their own target ids so one context serves the whole cart. */
interface TierWithTarget extends DiscountRuleTier {
  productId?: string | null;
  categoryId?: string | null;
}

export interface LoadedDiscountContext {
  tiers: TierWithTarget[];
  resolution: QtyDiscountResolution;
}

/**
 * Loads every candidate rule for `userId` across `products` in two queries.
 * Anonymous/guest pricing passes `userId = null` and gets global rules only.
 */
export async function loadDiscountContext(
  userId: string | Types.ObjectId | null,
  products: ProductScopeRef[],
  resolution: QtyDiscountResolution = QTY_DISCOUNT_RESOLUTION.SCOPE_OVERRIDE,
  now: Date = new Date(),
): Promise<LoadedDiscountContext> {
  const productIds = products.map((p) => toId(p.productId));
  const categoryIds = products
    .map((p) => p.categoryId)
    .filter((c): c is string | Types.ObjectId => Boolean(c))
    .map(toId);

  const scopeFilter = [
    { productId: { $in: productIds } },
    ...(categoryIds.length ? [{ categoryId: { $in: categoryIds } }] : []),
    { productId: null, categoryId: null },
  ];

  const [userRules, globalRules] = await Promise.all([
    userId
      ? UserQuantityDiscountRule.find({
          userId: toId(userId),
          status: RECORD_STATUS.ACTIVE,
          $or: scopeFilter,
        }).lean()
      : Promise.resolve([] as IUserQuantityDiscountRule[]),
    QuantityDiscountRule.find({
      status: RECORD_STATUS.ACTIVE,
      $or: scopeFilter,
    }).lean(),
  ]);

  const tiers: TierWithTarget[] = [];

  for (const rule of userRules as IUserQuantityDiscountRule[]) {
    if (!isWithinWindow(rule, now)) continue;
    tiers.push({
      ruleId: rule._id,
      scope: userScopeOf(rule),
      minimumQuantity: rule.minimumQuantity,
      discountPercentage: clampPercent(rule.discountPercentage),
      label: rule.label ?? null,
      productId: rule.productId ? String(rule.productId) : null,
      categoryId: rule.categoryId ? String(rule.categoryId) : null,
    });
  }

  for (const rule of globalRules as unknown as IQuantityDiscountRule[]) {
    if (!isWithinWindow(rule, now)) continue;
    tiers.push({
      ruleId: rule._id,
      scope: globalScopeOf(rule),
      minimumQuantity: rule.minimumQuantity,
      discountPercentage: clampPercent(rule.discountPercentage),
      label: rule.label ?? null,
      productId: rule.productId ? String(rule.productId) : null,
      categoryId: rule.categoryId ? String(rule.categoryId) : null,
    });
  }

  return { tiers, resolution };
}

/** Tiers from `context` that target this specific product, grouped by scope. */
function laddersForProduct(
  context: LoadedDiscountContext,
  product: ProductScopeRef,
): Map<QtyDiscountScope, DiscountRuleTier[]> {
  const productId = String(product.productId);
  const categoryId = product.categoryId ? String(product.categoryId) : null;
  const grouped = new Map<QtyDiscountScope, DiscountRuleTier[]>();

  for (const tier of context.tiers) {
    const targetsThisProduct = tier.productId && tier.productId === productId;
    const targetsThisCategory = tier.categoryId && categoryId && tier.categoryId === categoryId;
    const targetsEverything = !tier.productId && !tier.categoryId;
    if (!targetsThisProduct && !targetsThisCategory && !targetsEverything) continue;

    const bucket = grouped.get(tier.scope) ?? [];
    bucket.push({
      ruleId: tier.ruleId,
      scope: tier.scope,
      minimumQuantity: tier.minimumQuantity,
      discountPercentage: tier.discountPercentage,
      label: tier.label,
    });
    grouped.set(tier.scope, bucket);
  }

  for (const bucket of grouped.values()) bucket.sort((a, b) => a.minimumQuantity - b.minimumQuantity);
  return grouped;
}

const EMPTY_RESULT: ResolvedQuantityDiscount = {
  discountPercentage: 0,
  scope: null,
  ruleId: null,
  minimumQuantity: null,
  activeLadder: [],
  nextTier: null,
};

/** Highest qualifying tier in a ladder for the given quantity (RULE 7). */
function bestApplicableTier(ladder: DiscountRuleTier[], quantity: number): DiscountRuleTier | null {
  let best: DiscountRuleTier | null = null;
  for (const tier of ladder) {
    if (quantity < tier.minimumQuantity) continue;
    if (!best || tier.discountPercentage > best.discountPercentage) best = tier;
    // Tie-break on the higher threshold so the more "earned" tier is reported.
    else if (tier.discountPercentage === best.discountPercentage && tier.minimumQuantity > best.minimumQuantity) {
      best = tier;
    }
  }
  return best;
}

function nextUnreachedTier(ladder: DiscountRuleTier[], quantity: number): DiscountRuleTier | null {
  const upcoming = ladder
    .filter((t) => t.minimumQuantity > quantity && t.discountPercentage > 0)
    .sort((a, b) => a.minimumQuantity - b.minimumQuantity);
  return upcoming[0] ?? null;
}

/**
 * Resolves the discount for one cart line. Pure and synchronous - all database
 * access happened in {@link loadDiscountContext} - which is what makes this
 * cheap enough to call for every product in a listing response.
 */
export function resolveQuantityDiscount(
  context: LoadedDiscountContext,
  product: ProductScopeRef,
  quantity: number,
): ResolvedQuantityDiscount {
  const grouped = laddersForProduct(context, product);
  if (grouped.size === 0) return EMPTY_RESULT;

  if (context.resolution === QTY_DISCOUNT_RESOLUTION.BEST_APPLICABLE) {
    const everything = QTY_DISCOUNT_SCOPES.flatMap((scope) => grouped.get(scope) ?? []);
    const best = bestApplicableTier(everything, quantity);
    const ladder = everything.slice().sort((a, b) => a.minimumQuantity - b.minimumQuantity);
    return {
      discountPercentage: best?.discountPercentage ?? 0,
      scope: best?.scope ?? null,
      ruleId: best?.ruleId ?? null,
      minimumQuantity: best?.minimumQuantity ?? null,
      label: best?.label ?? null,
      activeLadder: ladder,
      nextTier: nextUnreachedTier(ladder, quantity),
    };
  }

  // SCOPE_OVERRIDE: the first (most specific) scope that has any rule wins,
  // whether or not the current quantity actually reaches one of its tiers.
  for (const scope of QTY_DISCOUNT_SCOPES) {
    const ladder = grouped.get(scope);
    if (!ladder || ladder.length === 0) continue;
    const best = bestApplicableTier(ladder, quantity);
    return {
      discountPercentage: best?.discountPercentage ?? 0,
      scope: best?.scope ?? scope,
      ruleId: best?.ruleId ?? null,
      minimumQuantity: best?.minimumQuantity ?? null,
      label: best?.label ?? null,
      activeLadder: ladder,
      nextTier: nextUnreachedTier(ladder, quantity),
    };
  }

  return EMPTY_RESULT;
}

/**
 * The ladder in force for a product at quantity 0 - used by product cards to
 * render "Buy 6+ and get 6% OFF" before anything is in the cart.
 */
export function previewLadder(
  context: LoadedDiscountContext,
  product: ProductScopeRef,
): DiscountRuleTier[] {
  const grouped = laddersForProduct(context, product);
  if (context.resolution === QTY_DISCOUNT_RESOLUTION.BEST_APPLICABLE) {
    const all = QTY_DISCOUNT_SCOPES.flatMap((scope) => grouped.get(scope) ?? []);
    // Collapse duplicate thresholds, keeping the most generous.
    const byQty = new Map<number, DiscountRuleTier>();
    for (const tier of all) {
      const existing = byQty.get(tier.minimumQuantity);
      if (!existing || tier.discountPercentage > existing.discountPercentage) {
        byQty.set(tier.minimumQuantity, tier);
      }
    }
    return [...byQty.values()].sort((a, b) => a.minimumQuantity - b.minimumQuantity);
  }
  for (const scope of QTY_DISCOUNT_SCOPES) {
    const ladder = grouped.get(scope);
    if (ladder?.length) return ladder;
  }
  return [];
}
