import { z } from 'zod';
import {
  COD_ADVANCE_MODE,
  COUPON_DISCOUNT_TYPE,
  DELIVERY_MODE,
  GST_MODE,
  ORDER_STATUS,
  PERMISSIONS,
  QTY_DISCOUNT_RESOLUTION,
  RECORD_STATUS,
  ROLES,
  USER_STATUS,
} from '../config/constants';
import {
  booleanQuery,
  email,
  gstNumber,
  indianMobile,
  numericQuery,
  objectId,
  optionalText,
  password,
  percentage,
  pincode,
  rupees,
  text,
} from './common.validator';

// ---------------------------------------------------------------------------
// User management (spec section 28)
// ---------------------------------------------------------------------------

export const adminUserListQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  q: z.string().trim().max(120).optional(),
  role: z.nativeEnum(ROLES).optional(),
  status: z.nativeEnum(USER_STATUS).optional(),
  customerGroup: z.string().trim().max(60).optional(),
  hasCustomPricing: booleanQuery,
  sort: z.enum(['newest', 'oldest', 'name_asc', 'name_desc', 'last_login']).optional(),
});

export const adminCreateUserSchema = z.object({
  name: text(120, 'Name'),
  email,
  mobile: indianMobile,
  password,
  role: z.nativeEnum(ROLES).default(ROLES.USER),
  status: z.nativeEnum(USER_STATUS).default(USER_STATUS.ACTIVE),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
  businessName: z.string().trim().max(160).optional(),
  gstNumber: gstNumber.optional(),
  customerGroup: z.string().trim().max(60).optional(),
  notes: optionalText(2000),
});

export const adminUpdateUserSchema = adminCreateUserSchema.partial().omit({ password: true });

export const adminSetUserStatusSchema = z.object({
  status: z.nativeEnum(USER_STATUS),
  reason: optionalText(300),
});

export const adminResetUserPasswordSchema = z.object({
  newPassword: password,
});

// ---------------------------------------------------------------------------
// User-specific pricing (spec sections 9, 33)
// ---------------------------------------------------------------------------

export const setUserPriceSchema = z.object({
  productId: objectId,
  customPrice: rupees,
  note: optionalText(500),
  status: z.nativeEnum(RECORD_STATUS).default(RECORD_STATUS.ACTIVE),
});

/**
 * Bulk assignment - the realistic admin workflow. Negotiating a rate card with
 * a dealer means setting dozens of prices at once, not one screen per part.
 */
export const bulkSetUserPricesSchema = z.object({
  entries: z
    .array(
      z.object({
        productId: objectId,
        customPrice: rupees,
        note: optionalText(500),
      }),
    )
    .min(1, 'Add at least one product')
    .max(500, 'Please split this into smaller batches'),
});

/** Apply a flat percentage off base price across a category or the catalogue. */
export const applyPricingRuleSchema = z
  .object({
    discountPercentage: percentage.optional(),
    /** Alternative to a percentage: a fixed rupee reduction from base price. */
    reduceBy: rupees.optional(),
    categoryId: objectId.optional(),
    productIds: z.array(objectId).max(500).optional(),
    /** Overwrite prices that already exist for this customer. */
    overwriteExisting: z.boolean().default(false),
    note: optionalText(500),
  })
  .refine((d) => d.discountPercentage !== undefined || d.reduceBy !== undefined, {
    message: 'Provide either a discount percentage or a fixed reduction',
    path: ['discountPercentage'],
  })
  .refine((d) => d.categoryId || d.productIds?.length, {
    message: 'Choose a category or specific products',
    path: ['categoryId'],
  });

export const copyPricingSchema = z.object({
  fromUserId: objectId,
  overwriteExisting: z.boolean().default(false),
});

export const userPriceListQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  q: z.string().trim().max(120).optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});

export const userProductParams = z.object({ userId: objectId, productId: objectId });
export const userParams = z.object({ userId: objectId });

// ---------------------------------------------------------------------------
// Quantity discounts (spec sections 11-13, 34)
// ---------------------------------------------------------------------------

const quantityRuleBase = {
  minimumQuantity: z
    .number()
    .int('Minimum quantity must be a whole number')
    .min(2, 'A quantity discount needs a threshold of at least 2'),
  discountPercentage: percentage.refine((v) => v > 0, 'Discount must be greater than 0'),
  label: optionalText(120),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  status: z.nativeEnum(RECORD_STATUS).default(RECORD_STATUS.ACTIVE),
};

/**
 * A rule targets a product, OR a category, OR everything - never two at once.
 * Allowing both would make "which rule wins" ambiguous, and an ambiguous
 * pricing rule is a support ticket waiting to happen.
 */
export const createQuantityRuleSchema = z
  .object({
    ...quantityRuleBase,
    productId: objectId.nullable().optional(),
    categoryId: objectId.nullable().optional(),
  })
  .refine((d) => !(d.productId && d.categoryId), {
    message: 'Choose either a product or a category, not both',
    path: ['categoryId'],
  })
  .refine((d) => !d.startDate || !d.endDate || d.endDate > d.startDate, {
    message: 'End date must be after the start date',
    path: ['endDate'],
  });

export const updateQuantityRuleSchema = z
  .object({
    minimumQuantity: quantityRuleBase.minimumQuantity.optional(),
    discountPercentage: percentage.optional(),
    label: optionalText(120),
    startDate: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
    status: z.nativeEnum(RECORD_STATUS).optional(),
  })
  .refine((d) => !d.startDate || !d.endDate || d.endDate > d.startDate, {
    message: 'End date must be after the start date',
    path: ['endDate'],
  });

export const createUserQuantityRuleSchema = z
  .object({
    ...quantityRuleBase,
    userId: objectId,
    productId: objectId.nullable().optional(),
    categoryId: objectId.nullable().optional(),
  })
  .refine((d) => !(d.productId && d.categoryId), {
    message: 'Choose either a product or a category, not both',
    path: ['categoryId'],
  });

/** Whole ladder in one submission - "6+ = 6%, 12+ = 10%, 24+ = 15%". */
export const setQuantityLadderSchema = z.object({
  productId: objectId.nullable().optional(),
  categoryId: objectId.nullable().optional(),
  userId: objectId.nullable().optional(),
  tiers: z
    .array(
      z.object({
        minimumQuantity: quantityRuleBase.minimumQuantity,
        discountPercentage: quantityRuleBase.discountPercentage,
        label: optionalText(120),
      }),
    )
    .min(1, 'Add at least one tier')
    .max(12, 'That is a lot of tiers - please simplify')
    .refine(
      (tiers) => new Set(tiers.map((t) => t.minimumQuantity)).size === tiers.length,
      'Each tier needs a different minimum quantity',
    )
    .refine((tiers) => {
      // A higher threshold must give at least as much discount, or customers
      // are punished for buying more - which is the opposite of the intent.
      const sorted = [...tiers].sort((a, b) => a.minimumQuantity - b.minimumQuantity);
      return sorted.every((t, i) => i === 0 || t.discountPercentage >= sorted[i - 1].discountPercentage);
    }, 'A larger quantity must not give a smaller discount'),
  /** Remove any existing tiers for this scope first. */
  replaceExisting: z.boolean().default(true),
});

export const quantityRuleListQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  scope: z.enum(['GLOBAL', 'PRODUCT', 'CATEGORY']).optional(),
  productId: objectId.optional(),
  categoryId: objectId.optional(),
  userId: objectId.optional(),
  status: z.nativeEnum(RECORD_STATUS).optional(),
});

// ---------------------------------------------------------------------------
// Coupons (spec sections 16, 17)
// ---------------------------------------------------------------------------

const couponFields = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(3, 'Coupon code must be at least 3 characters')
    .max(32)
    .regex(/^[A-Z0-9_-]+$/, 'Use only letters, numbers, hyphen and underscore'),
  title: optionalText(120),
  description: optionalText(500),
  discountType: z.nativeEnum(COUPON_DISCOUNT_TYPE),
  discountPercentage: percentage.default(0),
  discountAmount: rupees.default(0),
  minOrderValue: rupees.default(0),
  maxDiscountAmount: rupees.nullable().optional(),
  startDate: z.coerce.date().nullable().optional(),
  expiryDate: z.coerce.date().nullable().optional(),
  usageLimit: z.number().int().min(1).nullable().optional(),
  perUserUsageLimit: z.number().int().min(1).nullable().optional(),
  allowedUsers: z.array(objectId).max(2000).default([]),
  applicableCategories: z.array(objectId).max(100).default([]),
  applicableProducts: z.array(objectId).max(500).default([]),
  isPublic: z.boolean().default(true),
  isActive: z.boolean().default(true),
});

const datesInOrder = (d: { startDate?: Date | null; expiryDate?: Date | null }) =>
  !d.startDate || !d.expiryDate || d.expiryDate > d.startDate;

export const createCouponSchema = couponFields
  .refine((d) => d.discountType !== COUPON_DISCOUNT_TYPE.PERCENTAGE || d.discountPercentage > 0, {
    message: 'Enter a discount percentage',
    path: ['discountPercentage'],
  })
  .refine((d) => d.discountType !== COUPON_DISCOUNT_TYPE.FIXED || d.discountAmount > 0, {
    message: 'Enter a discount amount',
    path: ['discountAmount'],
  })
  .refine(datesInOrder, { message: 'Expiry must be after the start date', path: ['expiryDate'] });

/** Partial update - the discount-type/amount pairing is re-checked in the service. */
export const updateCouponSchema = couponFields
  .partial()
  .refine(datesInOrder, { message: 'Expiry must be after the start date', path: ['expiryDate'] });

export const couponListQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  q: z.string().trim().max(60).optional(),
  active: booleanQuery,
  expired: booleanQuery,
});

// ---------------------------------------------------------------------------
// Orders (spec section 25)
// ---------------------------------------------------------------------------

export const adminOrderListQuery = z.object({
  page: numericQuery(1),
  limit: numericQuery(1, 100),
  q: z.string().trim().max(120).optional(),
  status: z.nativeEnum(ORDER_STATUS).optional(),
  paymentMethod: z.enum(['ONLINE', 'COD']).optional(),
  paymentStatus: z.string().trim().max(30).optional(),
  userId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  minTotal: numericQuery(0),
  maxTotal: numericQuery(0),
  sort: z.enum(['newest', 'oldest', 'total_desc', 'total_asc']).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.nativeEnum(ORDER_STATUS),
  note: optionalText(500),
  trackingNumber: optionalText(80),
  courierName: optionalText(80),
});

export const recordCodCollectionSchema = z.object({
  amount: rupees.optional(),
  note: optionalText(300),
});

export const refundSchema = z.object({
  amount: rupees.optional(),
  reason: text(300, 'Refund reason'),
});

// ---------------------------------------------------------------------------
// Settings (spec section 32 / RULE 20)
// ---------------------------------------------------------------------------

const deliveryZoneSchema = z.object({
  label: text(80, 'Zone label'),
  pincodePrefixes: z
    .array(z.string().trim().regex(/^\d{2,6}$/, 'Use 2-6 digits of a PIN code'))
    .min(1, 'Add at least one PIN code prefix')
    .max(200),
  charge: rupees,
  freeAboveAmount: rupees.nullable().optional(),
  estimatedDays: z.number().int().min(0).max(60).optional(),
});

export const updateSettingsSchema = z
  .object({
    storeName: text(120, 'Store name').optional(),
    supportPhone: z.string().trim().max(20).optional().or(z.literal('')),
    supportEmail: z.string().trim().max(120).optional().or(z.literal('')),

    codEnabled: z.boolean().optional(),
    codMaxOrderAmount: rupees.optional(),
    codMinOrderAmount: rupees.optional(),
    codAdvanceRequired: z.boolean().optional(),
    codAdvanceMode: z.nativeEnum(COD_ADVANCE_MODE).optional(),
    codAdvanceAmount: rupees.optional(),
    codAdvancePercentage: percentage.optional(),
    codAdvanceMinAmount: rupees.optional(),
    codAdvanceMaxAmount: rupees.nullable().optional(),

    gstMode: z.nativeEnum(GST_MODE).optional(),
    defaultGstRate: percentage.optional(),

    deliveryMode: z.nativeEnum(DELIVERY_MODE).optional(),
    deliveryFlatCharge: rupees.optional(),
    deliveryFreeAboveAmount: rupees.optional(),
    deliveryPerKgCharge: rupees.optional(),
    deliveryMinCharge: rupees.optional(),
    deliveryMaxCharge: rupees.nullable().optional(),
    deliveryZones: z.array(deliveryZoneSchema).max(50).optional(),
    estimatedDeliveryDays: z.number().int().min(0).max(60).optional(),

    minOrderAmount: rupees.optional(),
    customerCancellationWindowHours: z.number().int().min(0).max(720).optional(),

    quantityDiscountResolution: z.nativeEnum(QTY_DISCOUNT_RESOLUTION).optional(),
    showMrpToCustomers: z.boolean().optional(),

    maintenanceMode: z.boolean().optional(),
    maintenanceMessage: optionalText(500),
    minSupportedAppVersion: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+$/, 'Use a version like 1.2.0')
      .optional()
      .or(z.literal('')),
  })
  // A COD advance larger than the COD ceiling would make COD impossible while
  // still appearing enabled.
  .refine(
    (d) =>
      d.codAdvanceAmount === undefined ||
      d.codMaxOrderAmount === undefined ||
      d.codAdvanceAmount <= d.codMaxOrderAmount,
    { message: 'The advance cannot exceed the COD order limit', path: ['codAdvanceAmount'] },
  );

// ---------------------------------------------------------------------------
// Notifications / reports
// ---------------------------------------------------------------------------

export const broadcastNotificationSchema = z.object({
  title: text(120, 'Title'),
  body: text(500, 'Message'),
  route: optionalText(200),
  image: z.string().trim().url().optional().or(z.literal('')),
  /** Empty = everyone. */
  userIds: z.array(objectId).max(5000).optional(),
});

export const reportQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: numericQuery(1, 100),
  days: numericQuery(1, 365),
  format: z.enum(['json', 'csv']).optional(),
});

export const serviceabilityCheckSchema = z.object({
  pincode,
  amount: rupees.optional(),
  weight: z.number().min(0).optional(),
});
