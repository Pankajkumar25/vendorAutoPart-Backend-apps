import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { PAYMENT_PURPOSE, TXN_STATUS, type PaymentPurpose, type TxnStatus } from '../config/constants';

/**
 * One row per gateway transaction attempt (spec section 20).
 *
 * `expectedAmount` is written when the transaction is created and is the only
 * amount ever trusted at verification time. The client tells us *which*
 * transaction succeeded; it never tells us how much was due. A tampered
 * "I paid ₹1" response fails the amount comparison in `payment.service`.
 */
export interface IPayment extends Document {
  _id: Types.ObjectId;
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: PaymentPurpose;
  provider: string;

  /** Gateway order id, e.g. Razorpay `order_xxx`. */
  providerOrderId: string;
  /** Gateway payment id, present once the customer completes the payment. */
  providerPaymentId?: string | null;
  providerSignature?: string | null;
  receipt: string;

  /** Authoritative amount in rupees, set server-side at creation. */
  expectedAmount: number;
  /** Amount the gateway reported as captured, in rupees. */
  capturedAmount?: number | null;
  currency: string;

  status: TxnStatus;
  method?: string | null;
  bank?: string | null;
  wallet?: string | null;
  vpa?: string | null;
  cardLast4?: string | null;
  failureReason?: string | null;

  /** Raw gateway payload, redacted of anything sensitive before storage. */
  gatewayResponse?: Record<string, unknown>;
  verifiedAt?: Date | null;
  refundedAmount: number;
  refundId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: Object.values(PAYMENT_PURPOSE), required: true },
    provider: { type: String, required: true, default: 'mock' },

    providerOrderId: { type: String, required: true, trim: true },
    providerPaymentId: { type: String, default: null, trim: true },
    providerSignature: { type: String, default: null, select: false },
    receipt: { type: String, required: true, trim: true },

    expectedAmount: { type: Number, required: true, min: 0 },
    capturedAmount: { type: Number, default: null, min: 0 },
    currency: { type: String, default: 'INR' },

    status: { type: String, enum: Object.values(TXN_STATUS), default: TXN_STATUS.CREATED, index: true },
    method: { type: String, default: null },
    bank: { type: String, default: null },
    wallet: { type: String, default: null },
    vpa: { type: String, default: null },
    cardLast4: { type: String, default: null },
    failureReason: { type: String, default: null },

    gatewayResponse: { type: Schema.Types.Mixed },
    verifiedAt: { type: Date, default: null },
    refundedAmount: { type: Number, default: 0, min: 0 },
    refundId: { type: String, default: null },
  },
  { timestamps: true },
);

paymentSchema.index({ providerOrderId: 1 }, { unique: true });
// Sparse+unique: a gateway payment id can only ever be recorded once, which
// makes the verify endpoint idempotent against replayed success callbacks.
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ orderId: 1, purpose: 1, status: 1 });
paymentSchema.index({ createdAt: -1 });

export type IPaymentModel = Model<IPayment>;

export const Payment =
  (mongoose.models.Payment as IPaymentModel) ??
  mongoose.model<IPayment, IPaymentModel>('Payment', paymentSchema);
