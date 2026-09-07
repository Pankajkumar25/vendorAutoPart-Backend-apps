import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import {
  ADDRESS_TYPES,
  ORDER_STATUS,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  type AddressType,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from '../config/constants';
import { orderItemSchema, type IOrderItem } from './orderItem.model';

/** Frozen copy of the delivery address, including GPS coordinates. */
export interface IOrderAddress {
  addressId?: Types.ObjectId;
  fullName: string;
  mobile: string;
  alternateMobile?: string;
  houseNumber: string;
  street?: string;
  area: string;
  landmark?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
  addressType: AddressType;
}

export interface IOrderStatusEvent {
  status: OrderStatus;
  note?: string;
  changedBy?: Types.ObjectId;
  changedByRole?: string;
  at: Date;
}

export interface IOrder extends Document {
  _id: Types.ObjectId;
  orderNumber: string;
  userId: Types.ObjectId;
  /** Denormalised for admin list views without a join. */
  customerName: string;
  customerMobile: string;

  items: IOrderItem[];

  // --- Money (all figures produced by the backend pricing engine) ---------
  /** Sum of grossAmount across items - before any discount. */
  itemsGross: number;
  /** Total quantity-discount value across all lines. */
  quantityDiscountTotal: number;
  /** Sum of lineSubtotal - the "products subtotal" the customer sees. */
  itemsSubtotal: number;
  couponCode?: string | null;
  couponId?: Types.ObjectId | null;
  couponDiscount: number;
  taxableAmount: number;
  gstTotal: number;
  deliveryCharge: number;
  /** Manual admin adjustment, e.g. goodwill credit. Negative reduces total. */
  adjustmentAmount: number;
  adjustmentReason?: string;
  grandTotal: number;
  /** Sum of (mrp - effectiveUnitPrice) * qty + discounts. Shown as "you saved". */
  totalSavings: number;

  // --- Payment ------------------------------------------------------------
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  /** COD advance that had to be paid online. 0 for fully-online orders. */
  advanceAmount: number;
  /** Advance actually received and verified. */
  advancePaidAmount: number;
  /** Balance to be collected in cash on delivery. */
  remainingCodAmount: number;
  amountPaidOnline: number;
  paidAt?: Date | null;
  codCollectedAt?: Date | null;

  // --- Fulfilment ---------------------------------------------------------
  address: IOrderAddress;
  status: OrderStatus;
  statusHistory: IOrderStatusEvent[];
  estimatedDeliveryDate?: Date | null;
  deliveredAt?: Date | null;
  cancelledAt?: Date | null;
  cancelReason?: string;
  cancelledByRole?: string;
  returnReason?: string;
  trackingNumber?: string;
  courierName?: string;
  customerNote?: string;
  adminNote?: string;

  /** Whether reserved stock has been returned to inventory. */
  stockRestored: boolean;
  /** Snapshot of the settings values the order was priced under. */
  pricingContext?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;

  readonly totalQuantity: number;
  readonly isPaidInFull: boolean;
}

const orderAddressSchema = new Schema<IOrderAddress>(
  {
    addressId: { type: Schema.Types.ObjectId, ref: 'Address' },
    fullName: { type: String, required: true },
    mobile: { type: String, required: true },
    alternateMobile: { type: String },
    houseNumber: { type: String, required: true },
    street: { type: String },
    area: { type: String, required: true },
    landmark: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
    country: { type: String, default: 'India' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    addressType: { type: String, enum: Object.values(ADDRESS_TYPES), default: ADDRESS_TYPES.SHOP },
  },
  { _id: false },
);

const statusEventSchema = new Schema<IOrderStatusEvent>(
  {
    status: { type: String, enum: Object.values(ORDER_STATUS), required: true },
    note: { type: String, maxlength: 500 },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    changedByRole: { type: String },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder>(
  {
    orderNumber: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    customerName: { type: String, required: true },
    customerMobile: { type: String, required: true },

    items: { type: [orderItemSchema], required: true, validate: [(v: unknown[]) => v.length > 0, 'Order must have at least one item'] },

    itemsGross: { type: Number, required: true, min: 0 },
    quantityDiscountTotal: { type: Number, default: 0, min: 0 },
    itemsSubtotal: { type: Number, required: true, min: 0 },
    couponCode: { type: String, default: null, uppercase: true, trim: true },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: null },
    couponDiscount: { type: Number, default: 0, min: 0 },
    taxableAmount: { type: Number, default: 0, min: 0 },
    gstTotal: { type: Number, default: 0, min: 0 },
    deliveryCharge: { type: Number, default: 0, min: 0 },
    adjustmentAmount: { type: Number, default: 0 },
    adjustmentReason: { type: String, maxlength: 300 },
    grandTotal: { type: Number, required: true, min: 0 },
    totalSavings: { type: Number, default: 0, min: 0 },

    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHODS), required: true, index: true },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
      index: true,
    },
    advanceAmount: { type: Number, default: 0, min: 0 },
    advancePaidAmount: { type: Number, default: 0, min: 0 },
    remainingCodAmount: { type: Number, default: 0, min: 0 },
    amountPaidOnline: { type: Number, default: 0, min: 0 },
    paidAt: { type: Date, default: null },
    codCollectedAt: { type: Date, default: null },

    address: { type: orderAddressSchema, required: true },
    status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING, index: true },
    statusHistory: { type: [statusEventSchema], default: [] },
    estimatedDeliveryDate: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, maxlength: 500 },
    cancelledByRole: { type: String },
    returnReason: { type: String, maxlength: 500 },
    trackingNumber: { type: String, trim: true },
    courierName: { type: String, trim: true },
    customerNote: { type: String, maxlength: 500 },
    adminNote: { type: String, maxlength: 1000 },

    stockRestored: { type: Boolean, default: false },
    pricingContext: { type: Schema.Types.Mixed },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ paymentMethod: 1, paymentStatus: 1, createdAt: -1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ customerMobile: 1 });
orderSchema.index({ 'items.productId': 1 });

orderSchema.virtual('totalQuantity').get(function totalQuantity(this: IOrder): number {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

orderSchema.virtual('isPaidInFull').get(function isPaidInFull(this: IOrder): boolean {
  if (this.paymentMethod === PAYMENT_METHODS.ONLINE) return this.paymentStatus === PAYMENT_STATUS.PAID;
  return this.paymentStatus === PAYMENT_STATUS.COD_COLLECTED;
});

export type IOrderModel = Model<IOrder>;

export const Order =
  (mongoose.models.Order as IOrderModel) ?? mongoose.model<IOrder, IOrderModel>('Order', orderSchema);
