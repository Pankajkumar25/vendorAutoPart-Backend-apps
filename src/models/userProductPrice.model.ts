import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { RECORD_STATUS, type RecordStatus } from '../config/constants';

/**
 * Per-customer selling price for a single product (spec sections 8-10, 33).
 *
 * Presence of an ACTIVE row here overrides `product.basePrice` for that one
 * customer and nobody else. There is exactly one row per (userId, productId)
 * pair, enforced by a unique compound index.
 */
export interface IUserProductPrice extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  productId: Types.ObjectId;
  customPrice: number;
  /** Base price captured at assignment time - useful for admin audit trails. */
  basePriceAtAssignment?: number;
  status: RecordStatus;
  note?: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const userProductPriceSchema = new Schema<IUserProductPrice>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    customPrice: {
      type: Number,
      required: [true, 'Custom price is required'],
      min: [0, 'Custom price cannot be negative'],
    },
    basePriceAtAssignment: { type: Number, min: 0 },
    status: {
      type: String,
      enum: Object.values(RECORD_STATUS),
      default: RECORD_STATUS.ACTIVE,
      index: true,
    },
    note: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

// Spec section 33: unique combination of userId + productId.
userProductPriceSchema.index({ userId: 1, productId: 1 }, { unique: true });
// Supports "all custom prices for this user" and "all customers priced on this
// product" - the two admin views in spec section 9.
userProductPriceSchema.index({ userId: 1, status: 1, updatedAt: -1 });
userProductPriceSchema.index({ productId: 1, status: 1, updatedAt: -1 });

export type IUserProductPriceModel = Model<IUserProductPrice>;

export const UserProductPrice =
  (mongoose.models.UserProductPrice as IUserProductPriceModel) ??
  mongoose.model<IUserProductPrice, IUserProductPriceModel>('UserProductPrice', userProductPriceSchema);
