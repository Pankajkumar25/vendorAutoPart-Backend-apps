import type { Request, Response } from 'express';
import { Category } from '../models/category.model';
import { Product } from '../models/product.model';
import { ok } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import { PRODUCT_STATUS, RECORD_STATUS } from '../config/constants';

/**
 * Category browse (spec section 5). Read-only for customers; the admin
 * equivalents live in `controllers/admin/adminCategory.controller.ts`.
 */

export async function listCategories(req: Request, res: Response): Promise<void> {
  const { featured, parent, includeEmpty } = req.query as Record<string, unknown>;

  const filter: Record<string, unknown> = { status: RECORD_STATUS.ACTIVE };
  if (featured === true) filter.isFeatured = true;
  if (parent) filter.parent = parent;
  // A category with nothing in it is a dead end for the customer, so it is
  // hidden unless the caller explicitly asks for the full tree.
  if (includeEmpty !== true) filter.productCount = { $gt: 0 };

  const categories = await Category.find(filter)
    .select('name slug description image icon colorHex parent sortOrder isFeatured productCount')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  ok(res, categories);
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const identifier = req.params.id ?? req.params.slug;

  const category = await Category.findOne({
    status: RECORD_STATUS.ACTIVE,
    ...(req.params.slug ? { slug: identifier } : { _id: identifier }),
  }).lean();

  if (!category) throw ApiError.notFound('Category not found');

  const [subCategories, brands, models] = await Promise.all([
    Category.find({ parent: category._id, status: RECORD_STATUS.ACTIVE })
      .select('name slug icon colorHex productCount')
      .sort({ sortOrder: 1, name: 1 })
      .lean(),
    // Facets for the filter sheet, taken from what is actually in stock rather
    // than a hardcoded list.
    Product.distinct('brand', { category: category._id, status: PRODUCT_STATUS.ACTIVE }),
    Product.distinct('compatibleModels', { category: category._id, status: PRODUCT_STATUS.ACTIVE }),
  ]);

  ok(res, {
    ...category,
    subCategories,
    filters: {
      brands: brands.filter(Boolean).sort(),
      compatibleModels: (models as string[]).filter(Boolean).sort(),
    },
  });
}

/** Category tiles for the home screen (spec section 5). */
export async function getFeaturedCategories(_req: Request, res: Response): Promise<void> {
  const categories = await Category.find({
    status: RECORD_STATUS.ACTIVE,
    isFeatured: true,
    productCount: { $gt: 0 },
  })
    .select('name slug icon colorHex image productCount')
    .sort({ sortOrder: 1, name: 1 })
    .limit(14)
    .lean();

  ok(res, categories);
}
