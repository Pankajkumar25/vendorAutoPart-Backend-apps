import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { RECORD_STATUS, type RecordStatus } from '../config/constants';

/**
 * Admin-configurable quantity discount ladder (spec sections 11-12, 34).
 *
 * Nothing about the tiers is hard-coded: the admin creates one row per tier,
 * e.g. `{ minimumQuantity: 3, discountPercentage: 2 }` and
 * `{ minimumQuantity: 6, discountPercentage: 6 }`, and can change them later
 * to 3% / 8% with no code change (RULE 5, RULE 20).
 *
 * Scope is determined by which reference is set:
 *   productId  -> applies to that product only          (most specific)
 *   categoryId -> applies to every product in the category
 *   neither    -> global fallback ladder                (least specific)
 */
export interface IQuantityDiscountRule extends Document {
  _id: Types.ObjectId;
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

  readonly scope: 'PRODUCT' | 'CATEGORY' | 'GLOBAL';
}

const quantityDiscountRuleSchema = new Schema<IQuantityDiscountRule>(
  {
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

// One tier per (scope, minimumQuantity) so an admin cannot create two
// conflicting "6+" rules on the same product.
quantityDiscountRuleSchema.index(
  { productId: 1, categoryId: 1, minimumQuantity: 1 },
  { unique: true, name: 'qty_rule_scope_tier_uq' },
);
quantityDiscountRuleSchema.index({ status: 1, minimumQuantity: -1 });

quantityDiscountRuleSchema.virtual('scope').get(function scope(this: IQuantityDiscountRule) {
  if (this.productId) return 'PRODUCT';
  if (this.categoryId) return 'CATEGORY';
  return 'GLOBAL';
});

quantityDiscountRuleSchema.pre('validate', function exclusiveScope(next) {
  if (this.productId && this.categoryId) {
    return next(new Error('A quantity discount rule targets either a product or a category, not both'));
  }
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    return next(new Error('endDate must be after startDate'));
  }
  return next();
});

export type IQuantityDiscountRuleModel = Model<IQuantityDiscountRule>;

export const QuantityDiscountRule =
  (mongoose.models.QuantityDiscountRule as IQuantityDiscountRuleModel) ??
  mongoose.model<IQuantityDiscountRule, IQuantityDiscountRuleModel>(
    'QuantityDiscountRule',
    quantityDiscountRuleSchema,
  );
