import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { RECORD_STATUS, type RecordStatus } from '../config/constants';

/**
 * Customer-specific quantity discount ladder (spec sections 13, 34).
 *
 * Lets the admin give Raj Traders `3+ = 3%, 6+ = 8%` while Sharma Auto Parts
 * gets `3+ = 2%, 6+ = 5%` for the very same product.
 *
 * Scope within a user, most specific first:
 *   userId + productId  -> that customer, that product
 *   userId + categoryId -> that customer, any product in the category
 *   userId only         -> that customer, any product
 */
export interface IUserQuantityDiscountRule extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  productId?: Types.ObjectId | null;
  categoryId?: Types.ObjectId | null;
  minimumQuantity: number;
  discountPercentage: number;
  status: RecordStatus;
  startDate?: Date | null;
  endDate?: Date | null;
  label?: string;
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;

  readonly scope: 'USER_PRODUCT' | 'USER_CATEGORY' | 'USER_GLOBAL';
}

const userQuantityDiscountRuleSchema = new Schema<IUserQuantityDiscountRule>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', default: null, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    minimumQuantity: {
      type: Number,
      required: [true, 'Minimum quantity is required'],
      min: [1, 'Minimum quantity must be at least 1'],
    },
    discountPercentage: {
      type: Number,
      required: [true, 'Discount percentage is required'],
      min: [0, 'Discount percentage cannot be negative'],
      max: [100, 'Discount percentage cannot exceed 100'],
    },
    status: {
      type: String,
      enum: Object.values(RECORD_STATUS),
      default: RECORD_STATUS.ACTIVE,
      index: true,
    },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    label: { type: String, trim: true, maxlength: 120 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

userQuantityDiscountRuleSchema.index(
  { userId: 1, productId: 1, categoryId: 1, minimumQuantity: 1 },
  { unique: true, name: 'user_qty_rule_scope_tier_uq' },
);
userQuantityDiscountRuleSchema.index({ userId: 1, status: 1, minimumQuantity: -1 });

userQuantityDiscountRuleSchema.virtual('scope').get(function scope(this: IUserQuantityDiscountRule) {
  if (this.productId) return 'USER_PRODUCT';
  if (this.categoryId) return 'USER_CATEGORY';
  return 'USER_GLOBAL';
});

userQuantityDiscountRuleSchema.pre('validate', function exclusiveScope(next) {
  if (this.productId && this.categoryId) {
    return next(new Error('A user quantity discount rule targets either a product or a category, not both'));
  }
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    return next(new Error('endDate must be after startDate'));
  }
  return next();
});

export type IUserQuantityDiscountRuleModel = Model<IUserQuantityDiscountRule>;

export const UserQuantityDiscountRule =
  (mongoose.models.UserQuantityDiscountRule as IUserQuantityDiscountRuleModel) ??
  mongoose.model<IUserQuantityDiscountRule, IUserQuantityDiscountRuleModel>(
    'UserQuantityDiscountRule',
    userQuantityDiscountRuleSchema,
  );
