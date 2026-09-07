import { z } from 'zod';
import { PRODUCT_STATUS, RECORD_STATUS } from '../config/constants';
import {
  booleanQuery,
  numericQuery,
  objectId,
  optionalText,
  percentage,
  quantity,
  rupees,
  stringArray,
  text,
} from './common.validator';

/** Catalogue browse / filter query (spec sections 7, 30). */
export const productListQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  sort: z
    .enum(['newest', 'oldest', 'price_asc', 'price_desc', 'popular', 'name_asc', 'name_desc', 'relevance'])
    .optional(),
  q: z.string().trim().max(120).optional(),
  category: objectId.optional(),
  categorySlug: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  minPrice: numericQuery(0),
  maxPrice: numericQuery(0),
  inStock: booleanQuery,
  featured: booleanQuery,
  bestSeller: booleanQuery,
  status: z.nativeEnum(PRODUCT_STATUS).optional(),
});

export const productIdParams = z.object({ id: objectId });
export const slugParams = z.object({ slug: z.string().trim().min(1).max(140) });

export const searchQuery = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(120),
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  category: objectId.optional(),
});

export const suggestQuery = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(80),
  limit: numericQuery(1, 20),
});

/** Price preview for a given quantity - powers the "buy 6 and save" hint. */
export const priceQuery = z.object({
  quantity: numericQuery(1, 100000),
});

// ---------------------------------------------------------------------------
// Admin product management (spec section 29)
// ---------------------------------------------------------------------------

const productImage = z.object({
  url: z.string().trim().url('Image URL is not valid'),
  publicId: z.string().trim().max(200).optional(),
  alt: z.string().trim().max(200).optional(),
  isPrimary: z.boolean().optional(),
});

export const createProductSchema = z
  .object({
    name: text(200, 'Product name'),
    sku: text(60, 'SKU').transform((v) => v.toUpperCase()),
    partNumber: text(60, 'Part number').transform((v) => v.toUpperCase()),
    alternatePartNumbers: stringArray(20, 60),
    brand: text(80, 'Brand'),
    category: objectId,
    images: z.array(productImage).max(8).optional(),
    description: optionalText(8000),
    shortDescription: optionalText(300),
    mrp: rupees,
    basePrice: rupees,
    stock: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).default(10),
    minOrderQuantity: z.number().int().min(1).default(1),
    maxOrderQuantity: z.number().int().min(1).optional(),
    weight: z.number().min(0).max(500_000).default(0),
    gstRate: percentage.default(18),
    hsnCode: optionalText(20),
    unit: z.string().trim().max(16).default('PCS'),
    compatibleModels: stringArray(60, 80),
    tags: stringArray(30, 40),
    status: z.nativeEnum(PRODUCT_STATUS).default(PRODUCT_STATUS.ACTIVE),
    isFeatured: z.boolean().default(false),
    isBestSeller: z.boolean().default(false),
    warranty: optionalText(200),
  })
  // Selling above MRP is not legal in India, so it is rejected rather than
  // merely warned about.
  .refine((data) => data.basePrice <= data.mrp, {
    message: 'Base price cannot be higher than MRP',
    path: ['basePrice'],
  })
  .refine((data) => !data.maxOrderQuantity || data.maxOrderQuantity >= data.minOrderQuantity, {
    message: 'Maximum order quantity must be at least the minimum',
    path: ['maxOrderQuantity'],
  });

export const updateProductSchema = z
  .object({
    name: text(200, 'Product name').optional(),
    sku: text(60, 'SKU').transform((v) => v.toUpperCase()).optional(),
    partNumber: text(60, 'Part number').transform((v) => v.toUpperCase()).optional(),
    alternatePartNumbers: stringArray(20, 60),
    brand: text(80, 'Brand').optional(),
    category: objectId.optional(),
    images: z.array(productImage).max(8).optional(),
    description: optionalText(8000),
    shortDescription: optionalText(300),
    mrp: rupees.optional(),
    basePrice: rupees.optional(),
    stock: z.number().int().min(0).optional(),
    lowStockThreshold: z.number().int().min(0).optional(),
    minOrderQuantity: z.number().int().min(1).optional(),
    maxOrderQuantity: z.number().int().min(1).nullable().optional(),
    weight: z.number().min(0).max(500_000).optional(),
    gstRate: percentage.optional(),
    hsnCode: optionalText(20),
    unit: z.string().trim().max(16).optional(),
    compatibleModels: stringArray(60, 80),
    tags: stringArray(30, 40),
    status: z.nativeEnum(PRODUCT_STATUS).optional(),
    isFeatured: z.boolean().optional(),
    isBestSeller: z.boolean().optional(),
    warranty: optionalText(200),
  })
  .refine((data) => data.mrp === undefined || data.basePrice === undefined || data.basePrice <= data.mrp, {
    message: 'Base price cannot be higher than MRP',
    path: ['basePrice'],
  });

/** Stock adjustment. `mode: 'delta'` is safer than 'set' for concurrent edits. */
export const stockAdjustSchema = z.object({
  quantity: z.number().int(),
  mode: z.enum(['set', 'delta']).default('delta'),
  note: optionalText(300),
});

export const bulkProductStatusSchema = z.object({
  productIds: z.array(objectId).min(1, 'Select at least one product').max(500),
  status: z.nativeEnum(PRODUCT_STATUS),
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const createCategorySchema = z.object({
  name: text(120, 'Category name'),
  description: optionalText(1000),
  image: z.string().trim().url().optional().or(z.literal('')),
  icon: z.string().trim().max(40).optional(),
  colorHex: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1E3A8A')
    .optional(),
  parent: objectId.nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isFeatured: z.boolean().default(false),
  status: z.nativeEnum(RECORD_STATUS).default(RECORD_STATUS.ACTIVE),
});

export const updateCategorySchema = createCategorySchema.partial();

export const categoryListQuery = z.object({
  featured: booleanQuery,
  includeEmpty: booleanQuery,
  parent: objectId.optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});

export { quantity };
