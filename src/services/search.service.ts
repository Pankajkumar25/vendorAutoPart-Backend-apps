import { Types } from 'mongoose';
import { Product } from '../models/product.model';
import { Category } from '../models/category.model';
import {
  MAX_RECENTLY_VIEWED,
  MAX_RECENT_SEARCHES,
  SearchTerm,
  UserActivity,
} from '../models/searchTerm.model';
import { PRODUCT_STATUS, RECORD_STATUS } from '../config/constants';
import { containsRegex, prefixRegex } from '../utils/slug';
import { logger } from '../config/logger';

/**
 * Search and suggestions (spec sections 6, 30).
 *
 * The spec asks for compound suggestions: typing "brake" should offer
 * "Brake Shoe", "Brake Pad", "Brake Cable"..., and typing "Pulsar" should offer
 * "Pulsar Engine Parts", "Pulsar Brake Parts"... Those are built from real
 * catalogue data rather than a hardcoded list, so they stay correct as the
 * catalogue grows:
 *
 *   - part-type suggestions come from distinct product names that contain the
 *     term ("brake" -> the actual brake products that exist)
 *   - vehicle suggestions come from `compatibleModels` crossed with the
 *     categories those products belong to ("Pulsar" x Brake Parts)
 *
 * Every suggestion therefore leads somewhere. A dead suggestion is worse than
 * no suggestion on a parts catalogue, where customers are already unsure
 * whether their part exists.
 */

export interface Suggestion {
  type: 'PRODUCT' | 'PART_TYPE' | 'VEHICLE' | 'CATEGORY' | 'BRAND' | 'PART_NUMBER';
  label: string;
  /** Query the app should run when this suggestion is tapped. */
  query: string;
  categoryId?: string;
  productId?: string;
  meta?: string;
}

const MAX_PER_GROUP = 6;

/** Title-cases a term for display without mangling part numbers. */
function displayTerm(term: string): string {
  return term
    .split(/\s+/)
    .map((w) => (w.length > 2 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

export async function getSuggestions(rawTerm: string, limit = 12): Promise<Suggestion[]> {
  const term = rawTerm.trim();
  if (term.length < 2) return [];

  const rx = containsRegex(term);
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();

  const push = (s: Suggestion) => {
    const key = `${s.type}:${s.label.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    suggestions.push(s);
  };

  const [exactPartNumbers, categories, vehicleGroups, partTypeGroups, brands] = await Promise.all([
    // 1. Part number / SKU. A mechanic who types a part number wants that part,
    //    not a fuzzy list - so this group comes first.
    Product.find({
      status: PRODUCT_STATUS.ACTIVE,
      $or: [
        { partNumber: prefixRegex(term) },
        { sku: prefixRegex(term) },
        { alternatePartNumbers: prefixRegex(term) },
      ],
    })
      .select('name partNumber sku category')
      .limit(4)
      .lean(),

    Category.find({ status: RECORD_STATUS.ACTIVE, name: rx })
      .select('name slug')
      .limit(4)
      .lean(),

    // 2. Vehicle model x category, e.g. "Pulsar 150" + "Brake Parts".
    Product.aggregate<{ _id: { model: string; category: Types.ObjectId }; count: number }>([
      { $match: { status: PRODUCT_STATUS.ACTIVE, compatibleModels: rx } },
      { $unwind: '$compatibleModels' },
      { $match: { compatibleModels: rx } },
      { $group: { _id: { model: '$compatibleModels', category: '$category' }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: MAX_PER_GROUP },
    ]),

    // 3. Part type, e.g. "brake" -> Brake Shoe / Brake Pad / Brake Cable.
    Product.aggregate<{ _id: string; count: number; categoryId: Types.ObjectId }>([
      { $match: { status: PRODUCT_STATUS.ACTIVE, name: rx } },
      {
        $group: {
          _id: '$name',
          count: { $sum: 1 },
          categoryId: { $first: '$category' },
          soldCount: { $sum: '$soldCount' },
        },
      },
      { $sort: { soldCount: -1, count: -1 } },
      { $limit: MAX_PER_GROUP + 4 },
    ]),

    Product.distinct('brand', { status: PRODUCT_STATUS.ACTIVE, brand: rx }),
  ]);

  for (const product of exactPartNumbers) {
    push({
      type: 'PART_NUMBER',
      label: product.partNumber,
      query: product.partNumber,
      productId: String(product._id),
      meta: product.name,
    });
  }

  // Resolve category names for the vehicle x category pairs in one query.
  const categoryIds = [
    ...new Set(vehicleGroups.map((g) => String(g._id.category)).concat(partTypeGroups.map((g) => String(g.categoryId)))),
  ];
  const categoryDocs = categoryIds.length
    ? await Category.find({ _id: { $in: categoryIds } }).select('name').lean()
    : [];
  const categoryNameById = new Map(categoryDocs.map((c) => [String(c._id), c.name]));

  for (const group of vehicleGroups) {
    const categoryName = categoryNameById.get(String(group._id.category));
    if (!categoryName) continue;
    push({
      type: 'VEHICLE',
      label: `${group._id.model} ${categoryName}`,
      query: `${group._id.model} ${categoryName}`,
      categoryId: String(group._id.category),
      meta: `${group.count} part${group.count === 1 ? '' : 's'}`,
    });
  }

  // Collapse product names down to the distinctive part-type phrase. Several
  // SKUs of "Brake Shoe" for different models should surface once.
  const partTypeSeen = new Set<string>();
  for (const group of partTypeGroups) {
    // Trim any trailing "- Pulsar 150" style qualifier for the label.
    const base = group._id.split(/\s+[-–|(]\s*/)[0].trim();
    const key = base.toLowerCase();
    if (partTypeSeen.has(key)) continue;
    partTypeSeen.add(key);
    push({
      type: 'PART_TYPE',
      label: displayTerm(base),
      query: base,
      categoryId: String(group.categoryId),
      meta: categoryNameById.get(String(group.categoryId)),
    });
    if (partTypeSeen.size >= MAX_PER_GROUP) break;
  }

  for (const category of categories) {
    push({ type: 'CATEGORY', label: category.name, query: category.name, categoryId: String(category._id) });
  }

  for (const brand of brands.slice(0, 3)) {
    push({ type: 'BRAND', label: brand, query: brand });
  }

  return suggestions.slice(0, limit);
}

/**
 * Builds the Mongo filter for a catalogue search.
 *
 * Text search is used when the term looks like words, and regex when it looks
 * like a part number - `$text` tokenises on word boundaries and would miss
 * "BJ-BS-150" typed as "BS-150".
 */
export function buildSearchFilter(term: string): Record<string, unknown> {
  const trimmed = term.trim();
  if (!trimmed) return {};

  const looksLikePartNumber = /[0-9]/.test(trimmed) && /[-_/]/.test(trimmed);
  const shortTerm = trimmed.length <= 3;

  if (looksLikePartNumber || shortTerm) {
    const rx = containsRegex(trimmed);
    return {
      $or: [
        { partNumber: rx },
        { sku: rx },
        { alternatePartNumbers: rx },
        { name: rx },
        { compatibleModels: rx },
      ],
    };
  }

  return { $text: { $search: trimmed } };
}

/** Records the term for "Popular searches". Never allowed to break a search. */
export async function recordSearch(params: {
  term: string;
  resultCount: number;
  userId?: Types.ObjectId | null;
}): Promise<void> {
  const term = params.term.trim().toLowerCase();
  if (term.length < 2 || term.length > 80) return;

  try {
    await SearchTerm.updateOne(
      { term },
      {
        $inc: { count: 1 },
        $set: { lastSearchedAt: new Date(), resultCount: params.resultCount },
        $setOnInsert: { isPromoted: false },
      },
      { upsert: true },
    );

    if (params.userId) {
      // Move the term to the front of the customer's recent list, de-duplicated.
      await UserActivity.updateOne(
        { userId: params.userId },
        { $pull: { recentSearches: { term } } },
        { upsert: true },
      );
      await UserActivity.updateOne(
        { userId: params.userId },
        {
          $push: {
            recentSearches: { $each: [{ term, at: new Date() }], $position: 0, $slice: MAX_RECENT_SEARCHES },
          },
        },
      );
    }
  } catch (err) {
    logger.warn('[search] failed to record search term', err);
  }
}

export async function getPopularSearches(limit = 10): Promise<string[]> {
  const terms = await SearchTerm.find({ resultCount: { $gt: 0 } })
    .sort({ isPromoted: -1, count: -1 })
    .limit(limit)
    .select('term')
    .lean();
  return terms.map((t) => displayTerm(t.term));
}

export async function getRecentSearches(userId: Types.ObjectId, limit = 8): Promise<string[]> {
  const activity = await UserActivity.findOne({ userId }).select('recentSearches').lean();
  return (activity?.recentSearches ?? []).slice(0, limit).map((s) => displayTerm(s.term));
}

export async function clearRecentSearches(userId: Types.ObjectId): Promise<void> {
  await UserActivity.updateOne({ userId }, { $set: { recentSearches: [] } });
}

// ---------------------------------------------------------------------------
// Recently viewed
// ---------------------------------------------------------------------------

export async function recordProductView(userId: Types.ObjectId | null, productId: string): Promise<void> {
  try {
    await Product.updateOne({ _id: productId }, { $inc: { viewCount: 1 } });
    if (!userId) return;
    const oid = new Types.ObjectId(productId);
    await UserActivity.updateOne({ userId }, { $pull: { recentlyViewed: { productId: oid } } }, { upsert: true });
    await UserActivity.updateOne(
      { userId },
      {
        $push: {
          recentlyViewed: {
            $each: [{ productId: oid, at: new Date() }],
            $position: 0,
            $slice: MAX_RECENTLY_VIEWED,
          },
        },
      },
    );
  } catch (err) {
    logger.warn('[search] failed to record product view', err);
  }
}

export async function getRecentlyViewedIds(userId: Types.ObjectId, limit = 10): Promise<string[]> {
  const activity = await UserActivity.findOne({ userId }).select('recentlyViewed').lean();
  return (activity?.recentlyViewed ?? []).slice(0, limit).map((r) => String(r.productId));
}
