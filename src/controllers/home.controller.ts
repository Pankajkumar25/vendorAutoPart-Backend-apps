import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Product } from '../models/product.model';
import { Category } from '../models/category.model';
import { decorateProducts, LIST_FIELDS, type ListedProduct } from './product.controller';
import { getPopularSearches, getRecentlyViewedIds } from '../services/search.service';
import { ok } from '../utils/apiResponse';
import { PRODUCT_STATUS, RECORD_STATUS } from '../config/constants';

/**
 * Home screen composite (spec section 5).
 *
 * The app's landing screen needs half a dozen rails - featured categories, best
 * sellers, new arrivals, the customer's recently viewed - and firing a request
 * per rail on a cold mobile connection is slow. This assembles them in one
 * round-trip, and every product rail is priced through `decorateProducts`, so
 * the home screen shows this customer's prices, not a generic list (RULES 1, 18).
 */

const RAIL_LIMIT = 10;

type LeanProduct = ListedProduct & { category?: unknown };

async function findRail(filter: Record<string, unknown>, sort: Record<string, 1 | -1>) {
  return Product.find({ status: PRODUCT_STATUS.ACTIVE, ...filter })
    .select(LIST_FIELDS)
    .populate('category', 'name slug')
    .sort(sort)
    .limit(RAIL_LIMIT)
    .lean<LeanProduct[]>();
}

export async function getHome(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId ?? null;

  const [featuredCategories, bestSellerDocs, newArrivalDocs, featuredDocs, popularSearches, recentlyViewedIds] =
    await Promise.all([
      Category.find({ status: RECORD_STATUS.ACTIVE, isFeatured: true, productCount: { $gt: 0 } })
        .select('name slug icon colorHex image productCount')
        .sort({ sortOrder: 1, name: 1 })
        .limit(14)
        .lean(),
      findRail({ isBestSeller: true }, { soldCount: -1, viewCount: -1 }),
      findRail({}, { createdAt: -1 }),
      findRail({ isFeatured: true }, { soldCount: -1 }),
      getPopularSearches(10),
      userId ? getRecentlyViewedIds(userId, RAIL_LIMIT) : Promise.resolve<string[]>([]),
    ]);

  // Recently viewed is fetched by id, then re-ordered to the recency order the
  // ids came in - a plain `$in` query would return them in natural order.
  let recentlyViewed: Awaited<ReturnType<typeof decorateProducts>> = [];
  if (recentlyViewedIds.length) {
    const docs = await Product.find({
      _id: { $in: recentlyViewedIds.map((id) => new Types.ObjectId(id)) },
      status: PRODUCT_STATUS.ACTIVE,
    })
      .select(LIST_FIELDS)
      .populate('category', 'name slug')
      .lean<LeanProduct[]>();
    const order = new Map(recentlyViewedIds.map((id, index) => [id, index]));
    docs.sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
    recentlyViewed = await decorateProducts(userId, docs);
  }

  const [bestSellers, newArrivals, featured] = await Promise.all([
    decorateProducts(userId, bestSellerDocs),
    decorateProducts(userId, newArrivalDocs),
    decorateProducts(userId, featuredDocs),
  ]);

  ok(res, {
    featuredCategories: featuredCategories.map((c) => ({
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      icon: c.icon ?? null,
      colorHex: c.colorHex ?? null,
      image: c.image ?? null,
      productCount: c.productCount,
    })),
    bestSellers,
    newArrivals,
    featured,
    recentlyViewed,
    popularSearches,
  });
}
