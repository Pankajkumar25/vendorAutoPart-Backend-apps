import type { Request, Response } from 'express';
import { Category } from '../../models/category.model';
import { Product } from '../../models/product.model';
import { ok, created, noContent } from '../../utils/apiResponse';
import { ApiError } from '../../utils/apiError';
import { slugify } from '../../utils/slug';
import { uniqueSlug } from './helpers';
import { RECORD_STATUS } from '../../config/constants';

/**
 * Category administration (spec section 29).
 *
 * `productCount` on each category is a denormalised figure maintained by the
 * product controller; this screen reads it and never trusts a client to set it.
 */

export async function listCategories(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  if (typeof query.status === 'string') filter.status = query.status;
  if (query.featured === true) filter.isFeatured = true;
  if (query.parent) filter.parent = query.parent;
  if (query.includeEmpty === false) filter.productCount = { $gt: 0 };

  const categories = await Category.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
  ok(
    res,
    categories.map((c) => ({
      id: String(c._id),
      name: c.name,
      slug: c.slug,
      description: c.description ?? null,
      image: c.image ?? null,
      icon: c.icon ?? null,
      colorHex: c.colorHex ?? null,
      parent: c.parent ? String(c.parent) : null,
      sortOrder: c.sortOrder,
      isFeatured: c.isFeatured,
      status: c.status,
      productCount: c.productCount,
      createdAt: c.createdAt,
    })),
  );
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const category = await Category.findById(req.params.id).lean();
  if (!category) throw ApiError.notFound('Category not found');
  ok(res, category);
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;

  if (body.parent) {
    const parent = await Category.findById(body.parent).select('_id').lean();
    if (!parent) throw ApiError.validation('The parent category does not exist');
  }

  const slug = await uniqueSlug(Category, slugify(String(body.name)));
  const category = await Category.create({ ...body, slug });
  created(res, category.toObject(), 'Category created');
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const category = await Category.findById(req.params.id);
  if (!category) throw ApiError.notFound('Category not found');

  const body = req.body as Record<string, unknown>;

  if (body.parent) {
    if (String(body.parent) === String(category._id)) {
      throw ApiError.validation('A category cannot be its own parent');
    }
    const parent = await Category.findById(body.parent).select('_id').lean();
    if (!parent) throw ApiError.validation('The parent category does not exist');
  }

  Object.assign(category, body);
  if (body.name !== undefined) {
    category.slug = await uniqueSlug(Category, slugify(String(body.name)), category._id);
  }
  await category.save();
  ok(res, category.toObject(), 'Category updated');
}

/**
 * A category may only be removed once it is empty and has no sub-categories -
 * deleting one out from under live products would orphan them and break the
 * catalogue. The admin is told exactly why instead of getting a silent failure.
 */
export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const category = await Category.findById(req.params.id);
  if (!category) throw ApiError.notFound('Category not found');

  const [productCount, childCount] = await Promise.all([
    Product.countDocuments({ category: category._id }),
    Category.countDocuments({ parent: category._id }),
  ]);
  if (productCount > 0) {
    throw ApiError.conflict(`This category still has ${productCount} product(s). Move or remove them first.`);
  }
  if (childCount > 0) {
    throw ApiError.conflict(`This category has ${childCount} sub-categor(y/ies). Remove them first.`);
  }

  await category.deleteOne();
  noContent(res);
}
