import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { COUPON_DISCOUNT_TYPE, type CouponDiscountType } from '../config/constants';

/**
 * Coupon definition (spec section 16).
 *
 * There is no `allowedPaymentMethods` field: RULE 9/10 make coupons
 * ONLINE-only, unconditionally, and that is enforced in `coupon.service`.
 */
export interface ICoupon extends Document {
  _id: Types.ObjectId;
  code: string;
  title?: string;
  description?: string;
  discountType: CouponDiscountType;
  /** Percentage when discountType = PERCENTAGE, else ignored. */
  discountPercentage: number;
  /** Rupees when discountType = FIXED, else ignored. */
  discountAmount: number;
  minOrderValue: number;
  /** Cap applied to a percentage discount. `null` = uncapped. */
  maxDiscountAmount?: number | null;
  startDate?: Date | null;
  expiryDate?: Date | null;
  /** Total redemptions allowed across all customers. `null` = unlimited. */
  usageLimit?: number | null;
  /** Redemptions allowed per customer. `null` = unlimited. */
  perUserUsageLimit?: number | null;
  usedCount: number;
  /** When non-empty the coupon is private to exactly these customers. */
  allowedUsers: Types.ObjectId[];
  /** Restrict eligibility to these categories (empty = all). */
  applicableCategories: Types.ObjectId[];
  applicableProducts: Types.ObjectId[];
  /** Surface it on the customer's "available offers" list. */
  isPublic: boolean;
  isActive: boolean;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<ICoupon>(
  {
    code: {
      type: String,
      required: [true, 'Coupon code is required'],
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 32,
      match: [/^[A-Z0-9_-]+$/, 'Coupon code may contain only letters, numbers, hyphen and underscore'],
    },
    title: { type: String, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    discountType: {
      type: String,
      enum: Object.values(COUPON_DISCOUNT_TYPE),
      required: true,
      default: COUPON_DISCOUNT_TYPE.PERCENTAGE,
    },
    discountPercentage: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0, min: 0 },
    minOrderValue: { type: Number, default: 0, min: 0 },
    maxDiscountAmount: { type: Number, default: null, min: 0 },
    startDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null, index: true },
    usageLimit: { type: Number, default: null, min: 1 },
    perUserUsageLimit: { type: Number, default: 1, min: 1 },
    usedCount: { type: Number, default: 0, min: 0 },
    allowedUsers: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [], index: true },
    applicableCategories: { type: [{ type: Schema.Types.ObjectId, ref: 'Category' }], default: [] },
    applicableProducts: { type: [{ type: Schema.Types.ObjectId, ref: 'Product' }], default: [] },
    isPublic: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

couponSchema.index({ code: 1 }, { unique: true });
couponSchema.index({ isActive: 1, isPublic: 1, expiryDate: 1 });

couponSchema.pre('validate', function validateDiscount(next) {
  if (this.discountType === COUPON_DISCOUNT_TYPE.PERCENTAGE && this.discountPercentage <= 0) {
    return next(new Error('A percentage coupon needs a discountPercentage greater than 0'));
  }
  if (this.discountType === COUPON_DISCOUNT_TYPE.FIXED && this.discountAmount <= 0) {
    return next(new Error('A fixed coupon needs a discountAmount greater than 0'));
  }
  if (this.startDate && this.expiryDate && this.expiryDate <= this.startDate) {
    return next(new Error('expiryDate must be after startDate'));
  }
  return next();
});

export type ICouponModel = Model<ICoupon>;

export const Coupon =
  (mongoose.models.Coupon as ICouponModel) ?? mongoose.model<ICoupon, ICouponModel>('Coupon', couponSchema);

/**
 * One row per successful redemption. Kept separate from the coupon document so
 * per-user limits can be enforced with an indexed count instead of an
 * unbounded array that grows without limit on a popular coupon.
 */
export interface ICouponRedemption extends Document {
  _id: Types.ObjectId;
  couponId: Types.ObjectId;
  code: string;
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  discountAmount: number;
  createdAt: Date;
  updatedAt: Date;
}

const couponRedemptionSchema = new Schema<ICouponRedemption>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    discountAmount: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

// A single order can never redeem the same coupon twice, even if the confirm
// endpoint is called concurrently.
couponRedemptionSchema.index({ couponId: 1, orderId: 1 }, { unique: true });
couponRedemptionSchema.index({ couponId: 1, userId: 1 });

export type ICouponRedemptionModel = Model<ICouponRedemption>;

export const CouponRedemption =
  (mongoose.models.CouponRedemption as ICouponRedemptionModel) ??
  mongoose.model<ICouponRedemption, ICouponRedemptionModel>('CouponRedemption', couponRedemptionSchema);
