import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { cartItemSchema, type ICartItem } from './cartItem.model';

export interface ICart extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  items: ICartItem[];
  /**
   * Coupon the customer typed. Stored only as a *hint* so the code survives an
   * app restart - it is re-validated from scratch at every price calculation
   * and silently ignored for COD.
   */
  couponCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const cartSchema = new Schema<ICart>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
    couponCode: { type: String, trim: true, uppercase: true, default: null },
  },
  { timestamps: true },
);

cartSchema.index({ updatedAt: -1 });

export type ICartModel = Model<ICart>;

export const Cart =
  (mongoose.models.Cart as ICartModel) ?? mongoose.model<ICart, ICartModel>('Cart', cartSchema);
