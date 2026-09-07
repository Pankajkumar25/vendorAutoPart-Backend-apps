import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Product, type IProduct } from '../models/product.model';
import { Category } from '../models/category.model';
import { attachListingPrices, calculateProductPrice } from '../services/pricing.service';
import { buildSearchFilter, recordProductView } from '../services/search.service';
import { getSettings } from '../services/settings.service';
import { ok, paginated } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import { buildPaginationMeta, parsePagination } from '../utils/pagination';
import { PRODUCT_STATUS } from '../config/constants';

/**
 * Product catalogue (spec sections 7, 8, 30).
 *
 * Every response that carries a price goes through `attachListingPrices` or
 * `calculateProductPrice`, both of which take the customer id from the verified
 * token. Two dealers hitting the identical URL therefore get different numbers
 * and neither can ask for the other's (RULES 1, 18, 19).
 */

/** Fields needed for a card. Descriptions are excluded from list payloads. */
export const LIST_FIELDS =
  'name slug sku partNumber brand category images mrp basePrice stock unit weight gstRate ' +
  'compatibleModels minOrderQuantity maxOrderQuantity status isFeatured isBestSeller soldCount ' +
  'ratingAverage ratingCount lowStockThreshold createdAt';

export type ListedProduct = Pick<
  IProduct,
  | '_id'
  | 'name'
  | 'slug'
  | 'sku'
  | 'partNumber'
  | 'brand'
  | 'category'
  | 'images'
  | 'mrp'
  | 'basePrice'
  | 'stock'
  | 'unit'
  | 'weight'
  | 'minOrderQuantity'
  | 'maxOrderQuantity'
  | 'compatibleModels'
  | 'isFeatured'
  | 'isBestSeller'
  | 'soldCount'
  | 'ratingAverage'
  | 'ratingCount'
  | 'lowStockThreshold'
>;

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  popular: { soldCount: -1, viewCount: -1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
  // Price sorts run on basePrice. A custom-price sort would have to fetch the
  // whole catalogue to be correct, and paginating on a per-customer computed
  // field is not worth the query cost here.
  price_asc: { basePrice: 1 },
  price_desc: { basePrice: -1 },
};

/**
 * Shapes a product plus its resolved price into the card payload the app draws.
 * `basePrice` is not leaked as "list price" unless the store chooses to show
 * MRP, so a discount a dealer negotiated is not advertised back at them as a
 * comparison to somebody else's price.
 */
function toCard(
  product: ListedProduct & { category?: unknown },
  price: ReturnType<typeof priceOrDefault>,
  showMrp: boolean,
) {
  const category = product.category as unknown;
  const populated =
    category && typeof category === 'object' && 'name' in (category as Record<string, unknown>)
      ? (category as { _id: Types.ObjectId; name: string; slug: string })
      : null;

  return {
    id: String(product._id),
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    partNumber: product.partNumber,
    brand: product.brand,
    category: populated
      ? { id: String(populated._id), name: populated.name, slug: populated.slug }
      : { id: String(category), name: null, slug: null },
    image: product.images?.find((i) => i.isPrimary)?.url ?? product.images?.[0]?.url ?? null,
    unit: product.unit,
    compatibleModels: product.compatibleModels ?? [],

    price: price.sellingPrice,
    mrp: showMrp ? price.mrp : null,
    hasCustomPrice: price.hasCustomPrice,
    savingsVsMrp: showMrp ? price.savingsVsMrp : null,
    discountPercentVsMrp: showMrp ? price.discountPercentVsMrp : null,
    quantityTiers: price.quantityTiers,

    inStock: product.stock > 0,
    stock: product.stock,
    isLowStock: product.stock > 0 && product.stock <= (product.lowStockThreshold ?? 0),
    minOrderQuantity: product.minOrderQuantity ?? 1,
    maxOrderQuantity: product.maxOrderQuantity ?? null,

    isFeatured: product.isFeatured,
    isBestSeller: product.isBestSeller,
    ratingAverage: product.ratingAverage,
    ratingCount: product.ratingCount,
  };
}

function priceOrDefault(
  map: Awaited<ReturnType<typeof attachListingPrices>>,
  product: { _id: Types.ObjectId; mrp: number; basePrice: number },
) {
  return (
    map.get(String(product._id)) ?? {
      productId: String(product._id),
      mrp: product.mrp,
      basePrice: product.basePrice,
      userPrice: null,
      hasCustomPrice: false,
      sellingPrice: product.basePrice,
      savingsVsMrp: Math.max(0, product.mrp - product.basePrice),
      discountPercentVsMrp: 0,
      quantityTiers: [],
    }
  );
}

/** Prices a page of products for whoever is asking, then maps them to cards. */
export async function decorateProducts(
  userId: Types.ObjectId | null,
  products: (ListedProduct & { category?: unknown })[],
) {
  const settings = await getSettings();
  const priceMap = await attachListingPrices(
    userId,
    products.map((p) => ({
      _id: p._id,
      mrp: p.mrp,
      basePrice: p.basePrice,
      category:
        p.category && typeof p.category === 'object' && '_id' in (p.category as unknown as Record<string, unknown>)
          ? ((p.category as { _id: Types.ObjectId })._id)
          : (p.category as Types.ObjectId | undefined) ?? null,
    })),
  );

  return products.map((product) =>
    toCard(product, priceOrDefault(priceMap, product), settings.showMrpToCustomers),
  );
}

export async function listProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = { status: PRODUCT_STATUS.ACTIVE };

  if (query.category) filter.category = query.category;
  if (query.categorySlug) {
    const category = await Category.findOne({ slug: query.categorySlug }).select('_id').lean();
    if (!category) throw ApiError.notFound('Category not found');
    filter.category = category._id;
  }
  if (query.brand) filter.brand = query.brand;
  if (query.model) filter.compatibleModels = query.model;
  if (query.featured === true) filter.isFeatured = true;
  if (query.bestSeller === true) filter.isBestSeller = true;
  if (query.inStock === true) filter.stock = { $gt: 0 };

  // Price filters are applied to basePrice for the same reason price sorting is:
  // it is the only price that is indexable across all customers.
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    const range: Record<string, number> = {};
    if (query.minPrice !== undefined) range.$gte = Number(query.minPrice);
    if (query.maxPrice !== undefined) range.$lte = Number(query.maxPrice);
    filter.basePrice = range;
  }

  const term = typeof query.q === 'string' ? query.q.trim() : '';
  if (term) Object.assign(filter, buildSearchFilter(term));

  const sortKey = typeof query.sort === 'string' ? query.sort : 'newest';
  const sort =
    term && (sortKey === 'relevance' || !SORTS[sortKey])
      ? { score: { $meta: 'textScore' } as never }
      : SORTS[sortKey] ?? SORTS.newest;

  const [products, total] = await Promise.all([
    Product.find(filter)
      .select(LIST_FIELDS)
      .populate('category', 'name slug')
      .sort(sort as Record<string, 1 | -1>)
      .skip(skip)
      .limit(limit)
      .lean<(ListedProduct & { category?: unknown })[]>(),
    Product.countDocuments(filter),
  ]);

  const items = await decorateProducts(req.auth?.userId ?? null, products);
  paginated(res, items, buildPaginationMeta(page, limit, total));
}

export async function getProduct(req: Request, res: Response): Promise<void> {
  const identifier = req.params.id ?? req.params.slug;
  const bySlug = Boolean(req.params.slug);

  const product = await Product.findOne(bySlug ? { slug: identifier } : { _id: identifier })
    .populate('category', 'name slug icon colorHex')
    .lean();

  if (!product || product.status === PRODUCT_STATUS.DISCONTINUED) {
    throw ApiError.notFound('Product not found');
  }

  const userId = req.auth?.userId ?? null;
  const settings = await getSettings();

  // Full breakdown at qty 1: MRP, base price, this customer's price and the
  // ladder that would apply if they bought more.
  const breakdown = await calculateProductPrice({ userId, productId: product._id, quantity: 1 });

  // View tracking must never delay or fail the response.
  void recordProductView(userId, String(product._id));

  const category = product.category as unknown as { _id: Types.ObjectId; name: string; slug: string } | null;

  ok(res, {
    id: String(product._id),
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    partNumber: product.partNumber,
    alternatePartNumbers: product.alternatePartNumbers ?? [],
    brand: product.brand,
    category: category ? { id: String(category._id), name: category.name, slug: category.slug } : null,
    images: product.images ?? [],
    description: product.description ?? null,
    shortDescription: product.shortDescription ?? null,
    compatibleModels: product.compatibleModels ?? [],
    tags: product.tags ?? [],
    warranty: product.warranty ?? null,
    unit: product.unit,
    weight: product.weight,
    hsnCode: product.hsnCode ?? null,
    gstRate: product.gstRate,

    pricing: {
      yourPrice: breakdown.effectiveUnitPrice,
      mrp: settings.showMrpToCustomers ? breakdown.mrp : null,
      hasCustomPrice: breakdown.hasCustomPrice,
      savingsVsMrp: settings.showMrpToCustomers ? breakdown.savingsVsMrp : null,
      discountPercentVsMrp: settings.showMrpToCustomers ? breakdown.discountPercentVsMrp : null,
      quantityDiscount: breakdown.quantityDiscount,
    },

    stock: product.stock,
    inStock: product.stock > 0,
    isLowStock: product.stock > 0 && product.stock <= (product.lowStockThreshold ?? 0),
    minOrderQuantity: product.minOrderQuantity ?? 1,
    maxOrderQuantity: product.maxOrderQuantity ?? null,

    isFeatured: product.isFeatured,
    isBestSeller: product.isBestSeller,
    ratingAverage: product.ratingAverage,
    ratingCount: product.ratingCount,
  });
}

/**
 * Live price for a quantity - drives the stepper on the product page so the
 * customer sees the slab discount appear at the exact unit it kicks in.
 * The number rendered here comes from the same engine that will price the
 * order, so the two cannot disagree.
 */
export async function getProductPrice(req: Request, res: Response): Promise<void> {
  const quantity = Number(req.query.quantity ?? 1) || 1;
  const breakdown = await calculateProductPrice({
    userId: req.auth?.userId ?? null,
    productId: req.params.id,
    quantity,
  });
  ok(res, breakdown);
}

/** "Similar parts" rail: same category, then same compatible models. */
export async function getRelatedProducts(req: Request, res: Response): Promise<void> {
  const product = await Product.findById(req.params.id).select('category compatibleModels').lean();
  if (!product) throw ApiError.notFound('Product not found');

  const related = await Product.find({
    _id: { $ne: product._id },
    status: PRODUCT_STATUS.ACTIVE,
    $or: [
      { category: product.category },
      ...(product.compatibleModels?.length ? [{ compatibleModels: { $in: product.compatibleModels } }] : []),
    ],
  })
    .select(LIST_FIELDS)
    .populate('category', 'name slug')
    .sort({ soldCount: -1 })
    .limit(12)
    .lean<(ListedProduct & { category?: unknown })[]>();

  ok(res, await decorateProducts(req.auth?.userId ?? null, related));
}

/** Facet values for the filter sheet, derived from the live catalogue. */
export async function getFilterOptions(req: Request, res: Response): Promise<void> {
  const categoryId = req.query.category as string | undefined;
  const base: Record<string, unknown> = { status: PRODUCT_STATUS.ACTIVE };
  if (categoryId) base.category = categoryId;

  const [brands, models, priceRange] = await Promise.all([
    Product.distinct('brand', base),
    Product.distinct('compatibleModels', base),
    Product.aggregate<{ _id: null; min: number; max: number }>([
      { $match: base },
      { $group: { _id: null, min: { $min: '$basePrice' }, max: { $max: '$basePrice' } } },
    ]),
  ]);

  ok(res, {
    brands: (brands as string[]).filter(Boolean).sort(),
    compatibleModels: (models as string[]).filter(Boolean).sort(),
    priceRange: { min: priceRange[0]?.min ?? 0, max: priceRange[0]?.max ?? 0 },
  });
}
