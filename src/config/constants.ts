/**
 * Shared enums / literal unions. Kept free of imports so both Mongoose models
 * and services can depend on them without cycles.
 */

export const ROLES = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

export const USER_STATUS = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  PENDING: 'PENDING',
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

/**
 * Fine grained admin capabilities. An ADMIN with an empty `permissions` array
 * is treated as a full admin (all capabilities). Populate the array to create
 * restricted staff accounts.
 */
export const PERMISSIONS = [
  'users.read',
  'users.write',
  'products.read',
  'products.write',
  'categories.read',
  'categories.write',
  'orders.read',
  'orders.write',
  'payments.read',
  'coupons.read',
  'coupons.write',
  'pricing.read',
  'pricing.write',
  'discounts.read',
  'discounts.write',
  'settings.read',
  'settings.write',
  'reports.read',
  'notifications.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ADDRESS_TYPES = {
  HOME: 'HOME',
  SHOP: 'SHOP',
  WAREHOUSE: 'WAREHOUSE',
  OTHER: 'OTHER',
} as const;
export type AddressType = (typeof ADDRESS_TYPES)[keyof typeof ADDRESS_TYPES];

export const PRODUCT_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DISCONTINUED: 'DISCONTINUED',
} as const;
export type ProductStatus = (typeof PRODUCT_STATUS)[keyof typeof PRODUCT_STATUS];

export const RECORD_STATUS = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
} as const;
export type RecordStatus = (typeof RECORD_STATUS)[keyof typeof RECORD_STATUS];

export const PAYMENT_METHODS = {
  ONLINE: 'ONLINE',
  COD: 'COD',
} as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[keyof typeof PAYMENT_METHODS];

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  ADVANCE_PAID: 'ADVANCE_PAID',
  PAID: 'PAID',
  COD_COLLECTED: 'COD_COLLECTED',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/** Purpose of an individual gateway transaction. */
export const PAYMENT_PURPOSE = {
  FULL: 'FULL',
  COD_ADVANCE: 'COD_ADVANCE',
} as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSE)[keyof typeof PAYMENT_PURPOSE];

export const TXN_STATUS = {
  CREATED: 'CREATED',
  ATTEMPTED: 'ATTEMPTED',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
} as const;
export type TxnStatus = (typeof TXN_STATUS)[keyof typeof TXN_STATUS];

export const WALLET_TXN_TYPE = {
  TOPUP: 'TOPUP',
  PAYMENT: 'PAYMENT',
  REFUND: 'REFUND',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type WalletTxnType = (typeof WALLET_TXN_TYPE)[keyof typeof WALLET_TXN_TYPE];

export const WALLET_TXN_STATUS = {
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type WalletTxnStatus = (typeof WALLET_TXN_STATUS)[keyof typeof WALLET_TXN_STATUS];

export const ORDER_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PROCESSING: 'PROCESSING',
  PACKED: 'PACKED',
  SHIPPED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  RETURNED: 'RETURNED',
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** Allowed forward transitions. Anything not listed is rejected by the API. */
export const ORDER_STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PACKED', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'RETURNED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: [],
  RETURNED: [],
};

/** Statuses at which a customer may still cancel their own order. */
export const USER_CANCELLABLE_STATUSES: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PROCESSING'];

export const COUPON_DISCOUNT_TYPE = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED: 'FIXED',
} as const;
export type CouponDiscountType = (typeof COUPON_DISCOUNT_TYPE)[keyof typeof COUPON_DISCOUNT_TYPE];

export const GST_MODE = {
  /** GST is added on top of the selling price. */
  EXCLUSIVE: 'EXCLUSIVE',
  /** Selling price already contains GST; tax is only broken out for the invoice. */
  INCLUSIVE: 'INCLUSIVE',
} as const;
export type GstMode = (typeof GST_MODE)[keyof typeof GST_MODE];

export const DELIVERY_MODE = {
  FREE: 'FREE',
  FLAT: 'FLAT',
  FREE_ABOVE: 'FREE_ABOVE',
  WEIGHT: 'WEIGHT',
} as const;
export type DeliveryMode = (typeof DELIVERY_MODE)[keyof typeof DELIVERY_MODE];

export const COD_ADVANCE_MODE = {
  FIXED: 'FIXED',
  PERCENTAGE: 'PERCENTAGE',
} as const;
export type CodAdvanceMode = (typeof COD_ADVANCE_MODE)[keyof typeof COD_ADVANCE_MODE];

/**
 * How competing quantity-discount scopes are resolved.
 *
 * SCOPE_OVERRIDE (default, matches the spec's "if a user-specific rule exists,
 *   use that rule"): the most specific scope that has *any* active rule wins
 *   outright, and the global/product ladders are ignored for that user.
 * BEST_APPLICABLE: every scope is considered and the single highest qualifying
 *   discount wins regardless of scope.
 */
export const QTY_DISCOUNT_RESOLUTION = {
  SCOPE_OVERRIDE: 'SCOPE_OVERRIDE',
  BEST_APPLICABLE: 'BEST_APPLICABLE',
} as const;
export type QtyDiscountResolution =
  (typeof QTY_DISCOUNT_RESOLUTION)[keyof typeof QTY_DISCOUNT_RESOLUTION];

/** Scope precedence, most specific first. Used by the discount resolver. */
export const QTY_DISCOUNT_SCOPES = [
  'USER_PRODUCT',
  'USER_CATEGORY',
  'USER_GLOBAL',
  'PRODUCT',
  'CATEGORY',
  'GLOBAL',
] as const;
export type QtyDiscountScope = (typeof QTY_DISCOUNT_SCOPES)[number];

export const OTP_PURPOSE = {
  REGISTER: 'REGISTER',
  FORGOT_PASSWORD: 'FORGOT_PASSWORD',
  LOGIN: 'LOGIN',
} as const;
export type OtpPurpose = (typeof OTP_PURPOSE)[keyof typeof OTP_PURPOSE];

export const NOTIFICATION_TYPE = {
  ORDER_PLACED: 'ORDER_PLACED',
  PAYMENT_SUCCESS: 'PAYMENT_SUCCESS',
  ADVANCE_PAYMENT_SUCCESS: 'ADVANCE_PAYMENT_SUCCESS',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  ORDER_PROCESSING: 'ORDER_PROCESSING',
  ORDER_PACKED: 'ORDER_PACKED',
  ORDER_SHIPPED: 'ORDER_SHIPPED',
  ORDER_OUT_FOR_DELIVERY: 'ORDER_OUT_FOR_DELIVERY',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_RETURNED: 'ORDER_RETURNED',
  NEW_COUPON: 'NEW_COUPON',
  NEW_PRODUCT: 'NEW_PRODUCT',
  SPECIAL_OFFER: 'SPECIAL_OFFER',
  GENERAL: 'GENERAL',
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export const CURRENCY = 'INR';
