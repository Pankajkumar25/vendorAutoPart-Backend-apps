import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { PRODUCT_STATUS, type ProductStatus } from '../config/constants';

export interface IProductImage {
  url: string;
  publicId?: string;
  alt?: string;
  isPrimary?: boolean;
}

export interface IProduct extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  sku: string;
  partNumber: string;
  /** Alternate/OEM part numbers customers may search by. */
  alternatePartNumbers: string[];
  brand: string;
  category: Types.ObjectId;
  images: IProductImage[];
  description?: string;
  shortDescription?: string;
  /** Printed maximum retail price - shown struck through. */
  mrp: number;
  /** Default selling price used when the customer has no custom price. */
  basePrice: number;
  stock: number;
  lowStockThreshold: number;
  minOrderQuantity: number;
  maxOrderQuantity?: number;
  /** Grams. Used by the weight-based delivery mode. */
  weight: number;
  /** GST percentage for this product (e.g. 18 or 28). */
  gstRate: number;
  hsnCode?: string;
  unit: string;
  compatibleModels: string[];
  tags: string[];
  status: ProductStatus;
  isFeatured: boolean;
  isBestSeller: boolean;
  /** Aggregate counters powering the "popular"/"best seller" home sections. */
  soldCount: number;
  viewCount: number;
  ratingAverage: number;
  ratingCount: number;
  warranty?: string;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;

  readonly primaryImage: string | null;
  readonly inStock: boolean;
  readonly isLowStock: boolean;
}

const productImageSchema = new Schema<IProductImage>(
  {
    url: { type: String, required: true, trim: true },
    publicId: { type: String, trim: true },
    alt: { type: String, trim: true, maxlength: 200 },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false },
);

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: [true, 'Product name is required'], trim: true, maxlength: 200 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    sku: { type: String, required: [true, 'SKU is required'], trim: true, uppercase: true, maxlength: 60 },
    partNumber: {
      type: String,
      required: [true, 'Part number is required'],
      trim: true,
      uppercase: true,
      maxlength: 60,
    },
    alternatePartNumbers: { type: [String], default: [], set: (v: string[]) => v.map((s) => s.trim().toUpperCase()) },
    brand: { type: String, required: true, trim: true, maxlength: 80, index: true },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    images: { type: [productImageSchema], default: [] },
    description: { type: String, trim: true, maxlength: 8000 },
    shortDescription: { type: String, trim: true, maxlength: 300 },
    mrp: { type: Number, required: true, min: [0, 'MRP cannot be negative'] },
    basePrice: { type: Number, required: true, min: [0, 'Base price cannot be negative'] },
    stock: { type: Number, required: true, min: [0, 'Stock cannot be negative'], default: 0 },
    lowStockThreshold: { type: Number, default: 10, min: 0 },
    minOrderQuantity: { type: Number, default: 1, min: 1 },
    maxOrderQuantity: { type: Number, min: 1 },
    weight: { type: Number, default: 0, min: 0 },
    gstRate: { type: Number, default: 18, min: 0, max: 100 },
    hsnCode: { type: String, trim: true, maxlength: 20 },
    unit: { type: String, default: 'PCS', trim: true, maxlength: 16 },
    compatibleModels: { type: [String], default: [], index: true },
    tags: { type: [String], default: [] },
    status: {
      type: String,
      enum: Object.values(PRODUCT_STATUS),
      default: PRODUCT_STATUS.ACTIVE,
      index: true,
    },
    isFeatured: { type: Boolean, default: false, index: true },
    isBestSeller: { type: Boolean, default: false, index: true },
    soldCount: { type: Number, default: 0, min: 0 },
    viewCount: { type: Number, default: 0, min: 0 },
    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    warranty: { type: String, trim: true, maxlength: 200 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

productSchema.index({ sku: 1 }, { unique: true });
productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ partNumber: 1 });
productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ status: 1, category: 1, createdAt: -1 });
productSchema.index({ status: 1, soldCount: -1 });
productSchema.index({ status: 1, basePrice: 1 });
// Weighted text index: a part-number match should outrank a description match.
productSchema.index(
  {
    name: 'text',
    partNumber: 'text',
    sku: 'text',
    brand: 'text',
    compatibleModels: 'text',
    tags: 'text',
    shortDescription: 'text',
    description: 'text',
  },
  {
    name: 'product_search_idx',
    weights: {
      partNumber: 30,
      sku: 25,
      name: 20,
      compatibleModels: 12,
      brand: 8,
      tags: 6,
      shortDescription: 3,
      description: 1,
    },
  },
);

productSchema.virtual('primaryImage').get(function primaryImage(this: IProduct): string | null {
  if (!this.images?.length) return null;
  return (this.images.find((img) => img.isPrimary) ?? this.images[0]).url;
});

productSchema.virtual('inStock').get(function inStock(this: IProduct): boolean {
  return this.stock > 0;
});

productSchema.virtual('isLowStock').get(function isLowStock(this: IProduct): boolean {
  return this.stock > 0 && this.stock <= this.lowStockThreshold;
});

/** Exactly one image may be primary; default to the first when none is flagged. */
productSchema.pre('save', function normaliseImages(next) {
  if (this.images?.length) {
    const primaries = this.images.filter((i) => i.isPrimary);
    if (primaries.length === 0) this.images[0].isPrimary = true;
    else if (primaries.length > 1) {
      let seen = false;
      this.images.forEach((img) => {
        if (img.isPrimary && seen) img.isPrimary = false;
        else if (img.isPrimary) seen = true;
      });
    }
  }
  return next();
});

export type IProductModel = Model<IProduct>;

export const Product =
  (mongoose.models.Product as IProductModel) ??
  mongoose.model<IProduct, IProductModel>('Product', productSchema);
