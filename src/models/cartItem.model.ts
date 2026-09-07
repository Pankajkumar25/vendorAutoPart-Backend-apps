import { Schema, type Types } from 'mongoose';

/**
 * A line inside a customer's cart.
 *
 * Deliberately stores **no price at all**. Prices are resolved by
 * `pricing.service` on every read, so a stale or tampered client value can
 * never reach an order (RULE 14, RULE 15). The cart is a list of intents:
 * "this product, this quantity".
 */
export interface ICartItem {
  productId: Types.ObjectId;
  quantity: number;
  /** Moved out of the active cart by "Save for later" but kept on the record. */
  savedForLater: boolean;
  addedAt: Date;
}

export const cartItemSchema = new Schema<ICartItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1'],
      max: [99999, 'Quantity is too large'],
      default: 1,
    },
    savedForLater: { type: Boolean, default: false },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);
