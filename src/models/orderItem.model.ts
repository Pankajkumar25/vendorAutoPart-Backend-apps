import { Schema, type Types } from 'mongoose';

/**
 * Immutable snapshot of one purchased line (spec section 24).
 *
 * Every number here is written by the backend pricing engine at order-creation
 * time and never recomputed afterwards. Product names, part numbers and prices
 * are copied rather than referenced so an invoice printed a year later still
 * shows what the customer actually agreed to, even if the product was renamed,
 * repriced or deleted.
 */
export interface IOrderItem {
  productId: Types.ObjectId;
  name: string;
  sku: string;
  partNumber: string;
  brand: string;
  image?: string;
  categoryId?: Types.ObjectId;

  quantity: number;
  unit: string;

  /** Printed MRP at purchase time. */
  mrp: number;
  /** Product default price at purchase time. */
  basePrice: number;
  /** Customer-specific price if one applied, else null. */
  userPrice: number | null;
  /** What the customer actually pays per unit before quantity discount. */
  effectiveUnitPrice: number;

  /** Which rule scope produced the quantity discount, for audit + support. */
  quantityDiscountScope?: string | null;
  quantityDiscountRuleId?: Types.ObjectId | null;
  quantityDiscountMinQty?: number | null;
  quantityDiscountPercentage: number;
  quantityDiscountAmount: number;

  /** effectiveUnitPrice * quantity, before any discount. */
  grossAmount: number;
  /** grossAmount - quantityDiscountAmount. */
  lineSubtotal: number;
  /** Share of the order-level coupon apportioned to this line. */
  couponDiscountShare: number;
  /** lineSubtotal - couponDiscountShare. The GST base under EXCLUSIVE mode. */
  taxableAmount: number;
  gstRate: number;
  gstAmount: number;
  /** taxableAmount + gstAmount under EXCLUSIVE; taxableAmount under INCLUSIVE. */
  lineTotal: number;
  weight: number;
}

export const orderItemSchema = new Schema<IOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    partNumber: { type: String, required: true },
    brand: { type: String, default: '' },
    image: { type: String },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },

    quantity: { type: Number, required: true, min: 1 },
    unit: { type: String, default: 'PCS' },

    mrp: { type: Number, required: true, min: 0 },
    basePrice: { type: Number, required: true, min: 0 },
    userPrice: { type: Number, default: null, min: 0 },
    effectiveUnitPrice: { type: Number, required: true, min: 0 },

    quantityDiscountScope: { type: String, default: null },
    quantityDiscountRuleId: { type: Schema.Types.ObjectId, default: null },
    quantityDiscountMinQty: { type: Number, default: null },
    quantityDiscountPercentage: { type: Number, default: 0, min: 0, max: 100 },
    quantityDiscountAmount: { type: Number, default: 0, min: 0 },

    grossAmount: { type: Number, required: true, min: 0 },
    lineSubtotal: { type: Number, required: true, min: 0 },
    couponDiscountShare: { type: Number, default: 0, min: 0 },
    taxableAmount: { type: Number, required: true, min: 0 },
    gstRate: { type: Number, default: 0, min: 0, max: 100 },
    gstAmount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
    weight: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);
