import mongoose, { Schema, type Document, type Model } from 'mongoose';
import {
  COD_ADVANCE_MODE,
  DELIVERY_MODE,
  GST_MODE,
  QTY_DISCOUNT_RESOLUTION,
  type CodAdvanceMode,
  type DeliveryMode,
  type GstMode,
  type QtyDiscountResolution,
} from '../config/constants';

/**
 * Single-document store for every business rule the admin can tune without a
 * code change (RULE 11, RULE 12, RULE 20). Loaded through `settings.service`
 * which caches it in-process and invalidates on write.
 *
 * Note what is deliberately *absent*: there is no "allow coupons on COD" flag.
 * RULE 9/10 make that an invariant of the domain, not a preference, so it is
 * enforced in code and cannot be switched off from the admin panel.
 */
export interface IDeliveryZone {
  /** Pincode prefixes this zone covers, e.g. `['400', '401']`. */
  pincodePrefixes: string[];
  label: string;
  charge: number;
  freeAboveAmount?: number | null;
  estimatedDays?: number;
}

export interface ISettings extends Document {
  key: 'app';

  // --- Store identity ------------------------------------------------------
  storeName: string;
  supportPhone?: string;
  supportEmail?: string;
  currency: string;

  // --- COD (spec 18, 19, 23) ----------------------------------------------
  codEnabled: boolean;
  /** Orders strictly above this total cannot use COD. Default ₹25,000. */
  codMaxOrderAmount: number;
  codMinOrderAmount: number;
  codAdvanceRequired: boolean;
  codAdvanceMode: CodAdvanceMode;
  /** Used when codAdvanceMode = FIXED. Default ₹2,000. */
  codAdvanceAmount: number;
  /** Used when codAdvanceMode = PERCENTAGE. */
  codAdvancePercentage: number;
  /** Floor/ceiling applied to a percentage-derived advance. */
  codAdvanceMinAmount: number;
  codAdvanceMaxAmount?: number | null;

  // --- Tax (spec 21, 22) ---------------------------------------------------
  gstMode: GstMode;
  /** Fallback rate for products with no explicit gstRate. */
  defaultGstRate: number;

  // --- Delivery ------------------------------------------------------------
  deliveryMode: DeliveryMode;
  deliveryFlatCharge: number;
  /** Under FREE_ABOVE / FLAT: orders at or above this ship free. */
  deliveryFreeAboveAmount: number;
  /** Under WEIGHT: charge per kg, applied to the total cart weight. */
  deliveryPerKgCharge: number;
  deliveryMinCharge: number;
  deliveryMaxCharge?: number | null;
  deliveryZones: IDeliveryZone[];
  estimatedDeliveryDays: number;

  // --- Order rules ---------------------------------------------------------
  minOrderAmount: number;
  /** Hours after placement during which a customer may self-cancel. */
  customerCancellationWindowHours: number;

  // --- Pricing behaviour ---------------------------------------------------
  quantityDiscountResolution: QtyDiscountResolution;
  /** Show MRP struck through next to "Your Price" on product cards. */
  showMrpToCustomers: boolean;

  // --- Platform ------------------------------------------------------------
  maintenanceMode: boolean;
  maintenanceMessage?: string;
  minSupportedAppVersion?: string;

  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const deliveryZoneSchema = new Schema<IDeliveryZone>(
  {
    pincodePrefixes: { type: [String], default: [] },
    label: { type: String, required: true, trim: true },
    charge: { type: Number, required: true, min: 0 },
    freeAboveAmount: { type: Number, min: 0, default: null },
    estimatedDays: { type: Number, min: 0, default: 3 },
  },
  { _id: false },
);

const settingsSchema = new Schema<ISettings>(
  {
    key: { type: String, default: 'app', enum: ['app'], unique: true, immutable: true },

    storeName: { type: String, default: 'AutoParts Pro', trim: true },
    supportPhone: { type: String, trim: true, default: '' },
    supportEmail: { type: String, trim: true, default: '' },
    currency: { type: String, default: 'INR', trim: true },

    codEnabled: { type: Boolean, default: true },
    codMaxOrderAmount: { type: Number, default: 25000, min: 0 },
    codMinOrderAmount: { type: Number, default: 0, min: 0 },
    codAdvanceRequired: { type: Boolean, default: true },
    codAdvanceMode: { type: String, enum: Object.values(COD_ADVANCE_MODE), default: COD_ADVANCE_MODE.FIXED },
    codAdvanceAmount: { type: Number, default: 2000, min: 0 },
    codAdvancePercentage: { type: Number, default: 10, min: 0, max: 100 },
    codAdvanceMinAmount: { type: Number, default: 0, min: 0 },
    codAdvanceMaxAmount: { type: Number, default: null, min: 0 },

    gstMode: { type: String, enum: Object.values(GST_MODE), default: GST_MODE.EXCLUSIVE },
    defaultGstRate: { type: Number, default: 18, min: 0, max: 100 },

    deliveryMode: { type: String, enum: Object.values(DELIVERY_MODE), default: DELIVERY_MODE.FREE_ABOVE },
    deliveryFlatCharge: { type: Number, default: 80, min: 0 },
    deliveryFreeAboveAmount: { type: Number, default: 3000, min: 0 },
    deliveryPerKgCharge: { type: Number, default: 40, min: 0 },
    deliveryMinCharge: { type: Number, default: 0, min: 0 },
    deliveryMaxCharge: { type: Number, default: null, min: 0 },
    deliveryZones: { type: [deliveryZoneSchema], default: [] },
    estimatedDeliveryDays: { type: Number, default: 4, min: 0 },

    minOrderAmount: { type: Number, default: 0, min: 0 },
    customerCancellationWindowHours: { type: Number, default: 24, min: 0 },

    quantityDiscountResolution: {
      type: String,
      enum: Object.values(QTY_DISCOUNT_RESOLUTION),
      default: QTY_DISCOUNT_RESOLUTION.SCOPE_OVERRIDE,
    },
    showMrpToCustomers: { type: Boolean, default: true },

    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: { type: String, trim: true, default: '' },
    minSupportedAppVersion: { type: String, trim: true, default: '' },

    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export type ISettingsModel = Model<ISettings>;

export const Settings =
  (mongoose.models.Settings as ISettingsModel) ??
  mongoose.model<ISettings, ISettingsModel>('Settings', settingsSchema);

/** Fields a customer-facing client is allowed to read. */
export const PUBLIC_SETTINGS_FIELDS = [
  'storeName',
  'supportPhone',
  'supportEmail',
  'currency',
  'codEnabled',
  'codMaxOrderAmount',
  'codMinOrderAmount',
  'codAdvanceRequired',
  'gstMode',
  'deliveryFreeAboveAmount',
  'estimatedDeliveryDays',
  'minOrderAmount',
  'customerCancellationWindowHours',
  'showMrpToCustomers',
  'maintenanceMode',
  'maintenanceMessage',
  'minSupportedAppVersion',
] as const;
