import type { Request, Response } from 'express';
import { Product } from '../models/product.model';
import {
  buildSearchFilter,
  clearRecentSearches,
  getPopularSearches,
  getRecentSearches,
  getRecentlyViewedIds,
  getSuggestions,
} from '../services/search.service';
import { recordSearch } from '../services/search.service';
import { requireAuth } from '../middleware/auth.middleware';
import { noContent, ok, paginated } from '../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../utils/pagination';
import { PRODUCT_STATUS } from '../config/constants';
import { decorateProducts, LIST_FIELDS, type ListedProduct } from './product.controller';

/**
 * Search (spec sections 6, 30).
 *
 * Results are priced per-customer like every other listing, so a search result
 * card shows the same number the product page will.
 */

export async function searchProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const term = typeof query.q === 'string' ? query.q.trim() : '';
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = { status: PRODUCT_STATUS.ACTIVE };
  if (term) Object.assign(filter, buildSearchFilter(term));
  if (query.category) filter.category = query.category;
  if (query.brand) filter.brand = query.brand;
  if (query.model) filter.compatibleModels = query.model;
  if (query.inStock === true) filter.stock = { $gt: 0 };

  const isTextSearch = '$text' in filter;

  const [products, total] = await Promise.all([
    Product.find(filter, isTextSearch ? { score: { $meta: 'textScore' } } : {})
      .select(LIST_FIELDS)
      .populate('category', 'name slug')
      // Relevance first for word searches; best sellers first for part-number
      // style searches, where every regex hit is equally "relevant".
      .sort(isTextSearch ? { score: { $meta: 'textScore' } } : { soldCount: -1, name: 1 })
      .skip(skip)
      .limit(limit)
      .lean<(ListedProduct & { category?: unknown })[]>(),
    Product.countDocuments(filter),
  ]);

  // Recorded after the count is known so "popular searches" can exclude terms
  // that find nothing. Fire-and-forget: analytics must not fail a search.
  if (term) {
    void recordSearch({ term, resultCount: total, userId: req.auth?.userId ?? null });
  }

  const items = await decorateProducts(req.auth?.userId ?? null, products);
  paginated(res, items, buildPaginationMeta(page, limit, total), undefined, { query: term });
}

export async function suggest(req: Request, res: Response): Promise<void> {
  const term = typeof req.query.q === 'string' ? req.query.q : '';
  const limit = Math.min(Number(req.query.limit ?? 12) || 12, 20);
  ok(res, await getSuggestions(term, limit));
}

/**
 * The empty search screen: what other dealers look for, plus this customer's
 * own history when they are signed in.
 */
export async function getSearchLanding(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId ?? null;
  const [popular, recent] = await Promise.all([
    getPopularSearches(10),
    userId ? getRecentSearches(userId, 8) : Promise.resolve([]),
  ]);
  ok(res, { popular, recent });
}

export async function clearRecent(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  await clearRecentSearches(auth.userId);
  noContent(res);
}

export async function getRecentlyViewed(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const ids = await getRecentlyViewedIds(auth.userId, Math.min(Number(req.query.limit ?? 10) || 10, 20));
  if (!ids.length) {
    ok(res, []);
    return;
  }

  const products = await Product.find({ _id: { $in: ids }, status: PRODUCT_STATUS.ACTIVE })
    .select(LIST_FIELDS)
    .populate('category', 'name slug')
    .lean<(ListedProduct & { category?: unknown })[]>();

  // Mongo returns index order; the customer expects most-recent-first.
  const order = new Map(ids.map((id, index) => [id, index]));
  products.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));

  ok(res, await decorateProducts(auth.userId, products));
}
