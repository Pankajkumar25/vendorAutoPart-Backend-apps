import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Product } from '../../models/product.model';
import { Category } from '../../models/category.model';
import { Order } from '../../models/order.model';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok, created, paginated, noContent } from '../../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/apiError';
import { slugify } from '../../utils/slug';
import { uniqueSlug } from './helpers';
import { PRODUCT_STATUS } from '../../config/constants';

/**
 * Product & catalogue administration (spec section 29).
 *
 * Unlike the customer catalogue this never runs prices through the pricing
 * engine - an admin manages `basePrice`/`mrp`/`stock` directly, and per-customer
 * prices are a different screen entirely (adminPricing). It also sees every
 * status, not just ACTIVE.
 */

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
  price_asc: { basePrice: 1 },
  price_desc: { basePrice: -1 },
  stock_asc: { stock: 1 },
  stock_desc: { stock: -1 },
  popular: { soldCount: -1 },
};

/**
 * Keeps `Category.productCount` in step with reality after any catalogue write.
 * Counts only ACTIVE products so the customer-facing category tiles never
 * advertise a count that includes hidden or discontinued parts.
 */
async function syncCategoryCounts(categoryIds: (Types.ObjectId | string | null | undefined)[]): Promise<void> {
  const unique = [...new Set(categoryIds.filter(Boolean).map((id) => String(id)))];
  await Promise.all(
    unique.map(async (id) => {
      const count = await Product.countDocuments({ category: id, status: PRODUCT_STATUS.ACTIVE });
      await Category.updateOne({ _id: id }, { $set: { productCount: count } });
    }),
  );
}

function toAdminCard(p: Record<string, unknown>) {
  const category = p.category as { _id?: Types.ObjectId; name?: string; slug?: string } | Types.ObjectId | undefined;
  const populated = category && typeof category === 'object' && 'name' in category ? category : null;
  const images = (p.images as { url: string; isPrimary?: boolean }[]) ?? [];
  return {
    id: String(p._id),
    name: p.name,
    slug: p.slug,
    sku: p.sku,
    partNumber: p.partNumber,
    brand: p.brand,
    category: populated
      ? { id: String(populated._id), name: populated.name, slug: populated.slug }
      : { id: category ? String(category) : null, name: null, slug: null },
    image: images.find((i) => i.isPrimary)?.url ?? images[0]?.url ?? null,
    mrp: p.mrp,
    basePrice: p.basePrice,
    stock: p.stock,
    lowStockThreshold: p.lowStockThreshold,
    isLowStock: (p.stock as number) > 0 && (p.stock as number) <= ((p.lowStockThreshold as number) ?? 0),
    status: p.status,
    isFeatured: p.isFeatured,
    isBestSeller: p.isBestSeller,
    soldCount: p.soldCount,
    gstRate: p.gstRate,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
  };
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = {};
  if (typeof query.status === 'string') filter.status = query.status;
  if (query.category) filter.category = query.category;
  if (typeof query.brand === 'string') filter.brand = query.brand;
  if (query.featured === true) filter.isFeatured = true;
  if (query.bestSeller === true) filter.isBestSeller = true;
  if (query.inStock === true) filter.stock = { $gt: 0 };
  // Low-stock triage view: at or below threshold but not yet zero.
  if (query.lowStock === true) filter.$expr = { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', '$lowStockThreshold'] }] };
  if (typeof query.q === 'string' && query.q.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { sku: rx }, { partNumber: rx }, { brand: rx }, { alternatePartNumbers: rx }];
  }

  const sort = SORTS[String(query.sort ?? 'newest')] ?? SORTS.newest;

  const [rows, total] = await Promise.all([
    Product.find(filter).select('-description').populate('category', 'name slug').sort(sort).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  paginated(res, rows.map(toAdminCard), buildPaginationMeta(page, limit, total));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const product = await Product.findById(req.params.id).populate('category', 'name slug').lean();
  if (!product) throw ApiError.notFound('Product not found');
  ok(res, product);
}

export async function createProduct(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const body = req.body as Record<string, unknown>;

  const category = await Category.findById(body.category).select('_id').lean();
  if (!category) throw ApiError.validation('The selected category does not exist');

  const existing = await Product.findOne({ sku: body.sku }).select('_id').lean();
  if (existing) throw ApiError.conflict('A product with this SKU already exists');

  const slug = await uniqueSlug(Product, slugify(String(body.name)));
  const product = await Product.create({ ...body, slug, createdBy: actor.userId });
  await syncCategoryCounts([product.category]);

  created(res, product.toObject(), 'Product created');
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  const body = req.body as Record<string, unknown>;
  const previousCategory = String(product.category);

  // MRP/basePrice may arrive one at a time; validate the pair against whatever
  // the *resulting* document will hold, not just the fields in this request.
  const nextMrp = body.mrp !== undefined ? Number(body.mrp) : product.mrp;
  const nextBase = body.basePrice !== undefined ? Number(body.basePrice) : product.basePrice;
  if (nextBase > nextMrp) throw ApiError.validation('Base price cannot be higher than MRP', { path: 'basePrice' });

  if (body.sku && body.sku !== product.sku) {
    const clash = await Product.findOne({ sku: body.sku, _id: { $ne: product._id } }).select('_id').lean();
    if (clash) throw ApiError.conflict('A product with this SKU already exists');
  }
  if (body.category) {
    const category = await Category.findById(body.category).select('_id').lean();
    if (!category) throw ApiError.validation('The selected category does not exist');
  }

  Object.assign(product, body);
  // The public URL follows the name; regenerate the slug when the name changes
  // (unless a slug was somehow supplied) so links stay meaningful.
  if (body.name !== undefined) {
    product.slug = await uniqueSlug(Product, slugify(String(body.name)), product._id);
  }
  await product.save();

  // A category move or a visibility change can shift the count of either side.
  await syncCategoryCounts([previousCategory, String(product.category)]);

  ok(res, product.toObject(), 'Product updated');
}

/**
 * Direct stock correction (spec section 29). `delta` is the safe default -
 * two admins each adding 10 units both take effect, whereas two `set` calls
 * would clobber each other. A delta is never allowed to drive stock negative.
 */
export async function adjustStock(req: Request, res: Response): Promise<void> {
  const body = req.body as { quantity: number; mode: 'set' | 'delta'; note?: string };

  if (body.mode === 'set') {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: { stock: body.quantity } },
      { new: true },
    );
    if (!product) throw ApiError.notFound('Product not found');
    ok(res, { id: String(product._id), stock: product.stock }, 'Stock updated');
    return;
  }

  // Guarded conditional update so a concurrent order cannot let this drive
  // stock below zero.
  const filter: Record<string, unknown> = { _id: req.params.id };
  if (body.quantity < 0) filter.stock = { $gte: Math.abs(body.quantity) };

  const product = await Product.findOneAndUpdate(filter, { $inc: { stock: body.quantity } }, { new: true });
  if (!product) {
    const exists = await Product.exists({ _id: req.params.id });
    throw exists
      ? ApiError.badRequest('Not enough stock to apply this reduction')
      : ApiError.notFound('Product not found');
  }
  ok(res, { id: String(product._id), stock: product.stock }, 'Stock updated');
}

export async function bulkSetStatus(req: Request, res: Response): Promise<void> {
  const body = req.body as { productIds: string[]; status: string };

  const affected = await Product.find({ _id: { $in: body.productIds } }).select('category').lean();
  const result = await Product.updateMany({ _id: { $in: body.productIds } }, { $set: { status: body.status } });
  await syncCategoryCounts(affected.map((p) => p.category));

  ok(res, { matched: result.matchedCount, modified: result.modifiedCount }, 'Products updated');
}

/**
 * Removes a product. If it has ever appeared on an order it is *discontinued*
 * rather than deleted, so historical orders and reports keep resolving it; a
 * product that was never ordered is safe to hard-delete.
 */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  const ordered = await Order.exists({ 'items.productId': product._id });
  if (ordered) {
    product.status = PRODUCT_STATUS.DISCONTINUED;
    await product.save();
    await syncCategoryCounts([product.category]);
    ok(res, { id: String(product._id), discontinued: true }, 'Product has past orders and was discontinued instead of deleted');
    return;
  }

  const categoryId = product.category;
  await product.deleteOne();
  await syncCategoryCounts([categoryId]);
  noContent(res);
}
