import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';

/**
 * Checkout session — a lightweight pre-order record that holds pricing and
 * cart state while the customer completes payment.  The real Order is only
 * created once the gateway confirms the payment (or immediately for COD).
 *
 * This prevents ghost orders from accumulating when customers abandon the
 * payment sheet or hit errors.
 */
export interface ICheckoutSession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;

  /** Snapshot of the cart items at checkout time. */
  items: {
    productId: Types.ObjectId;
    quantity: number;
    name: string;
    partNumber: string;
    sku?: string;
    image?: string;
    unitPrice: number;
    mrp: number;
    gstRate: number;
    weight?: number;
    quantityDiscountAmount: number;
    lineTotal: number;
  }[];

  /** Delivery address snapshot. */
  address: {
    fullName: string;
    mobile: string;
    alternateMobile?: string;
    houseNumber?: string;
    street?: string;
    area?: string;
    landmark?: string;
    city: string;
    state: string;
    pincode: string;
    country: string;
    addressType?: string;
  };

  paymentMethod: string;
  couponCode?: string | null;
  couponId?: Types.ObjectId | null;
  customerNote?: string;

  /** Server-computed pricing (same structure as Order charges). */
  itemsGross: number;
  quantityDiscountTotal: number;
  itemsSubtotal: number;
  couponDiscount: number;
  taxableAmount: number;
  gstTotal: number;
  deliveryCharge: number;
  grandTotal: number;
  totalSavings: number;

  /** COD-specific. */
  advanceAmount: number;
  remainingCodAmount: number;

  /** Razorpay handoff info. */
  providerOrderId?: string;
  provider?: string;
  publicKey?: string;
  currency?: string;
  amountDueNow: number;

  status: 'PENDING' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';
  createdAt: Date;
  updatedAt: Date;
}

const checkoutSessionSchema = new Schema<ICheckoutSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    items: [
      {
        productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
        quantity: { type: Number, required: true },
        name: { type: String, required: true },
        partNumber: { type: String, default: '' },
        sku: { type: String, default: '' },
        image: { type: String, default: '' },
        unitPrice: { type: Number, required: true },
        mrp: { type: Number, required: true },
        gstRate: { type: Number, required: true },
        weight: { type: Number, default: 0 },
        quantityDiscountAmount: { type: Number, default: 0 },
        lineTotal: { type: Number, required: true },
      },
    ],

    address: {
      fullName: { type: String, required: true },
      mobile: { type: String, required: true },
      alternateMobile: String,
      houseNumber: String,
      street: String,
      area: String,
      landmark: String,
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      country: { type: String, default: 'India' },
      addressType: String,
    },

    paymentMethod: { type: String, required: true },
    couponCode: { type: String, default: null },
    couponId: { type: Schema.Types.ObjectId, default: null },
    customerNote: { type: String, default: null },

    itemsGross: { type: Number, required: true },
    quantityDiscountTotal: { type: Number, default: 0 },
    itemsSubtotal: { type: Number, required: true },
    couponDiscount: { type: Number, default: 0 },
    taxableAmount: { type: Number, required: true },
    gstTotal: { type: Number, required: true },
    deliveryCharge: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true },
    totalSavings: { type: Number, default: 0 },

    advanceAmount: { type: Number, default: 0 },
    remainingCodAmount: { type: Number, default: 0 },

    providerOrderId: { type: String, default: null },
    provider: { type: String, default: null },
    publicKey: { type: String, default: null },
    currency: { type: String, default: 'INR' },
    amountDueNow: { type: Number, default: 0 },

    status: { type: String, enum: ['PENDING', 'COMPLETED', 'EXPIRED', 'CANCELLED'], default: 'PENDING', index: true },
  },
  { timestamps: true },
);

checkoutSessionSchema.index({ userId: 1, status: 1, createdAt: -1 });
checkoutSessionSchema.index({ providerOrderId: 1 }, { sparse: true });

export type ICheckoutSessionModel = Model<ICheckoutSession>;

export const CheckoutSession =
  (mongoose.models.CheckoutSession as ICheckoutSessionModel) ??
  mongoose.model<ICheckoutSession, ICheckoutSessionModel>('CheckoutSession', checkoutSessionSchema);
