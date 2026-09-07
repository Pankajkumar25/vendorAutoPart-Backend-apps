/**
 * Typed application error. Anything thrown that is *not* an ApiError is
 * treated by the error middleware as an unexpected fault and reported to the
 * client as a generic 500 with no internal detail.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isOperational = true;

  constructor(statusCode: number, message: string, code = 'ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message = 'Invalid request', code = 'BAD_REQUEST', details?: unknown) {
    return new ApiError(400, message, code, details);
  }

  static validation(message = 'Validation failed', details?: unknown) {
    return new ApiError(422, message, 'VALIDATION_ERROR', details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }

  static sessionExpired(message = 'Your session has expired. Please sign in again.') {
    return new ApiError(401, message, 'SESSION_EXPIRED');
  }

  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }

  static conflict(message = 'Resource already exists', code = 'CONFLICT', details?: unknown) {
    return new ApiError(409, message, code, details);
  }

  static tooMany(message = 'Too many requests. Please try again later.', code = 'RATE_LIMITED') {
    return new ApiError(429, message, code);
  }

  static internal(message = 'Something went wrong', code = 'INTERNAL_ERROR') {
    return new ApiError(500, message, code);
  }
}

/** Domain-specific error codes the mobile app switches on for its UI states. */
export const ERROR_CODES = {
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  BELOW_MOQ: 'BELOW_MOQ',
  CART_EMPTY: 'CART_EMPTY',
  COUPON_INVALID: 'COUPON_INVALID',
  COUPON_EXPIRED: 'COUPON_EXPIRED',
  COUPON_NOT_STARTED: 'COUPON_NOT_STARTED',
  COUPON_MIN_ORDER: 'COUPON_MIN_ORDER',
  COUPON_USAGE_EXCEEDED: 'COUPON_USAGE_EXCEEDED',
  COUPON_USER_LIMIT_EXCEEDED: 'COUPON_USER_LIMIT_EXCEEDED',
  COUPON_NOT_FOR_USER: 'COUPON_NOT_FOR_USER',
  COUPON_NOT_ALLOWED_FOR_COD: 'COUPON_NOT_ALLOWED_FOR_COD',
  COD_DISABLED: 'COD_DISABLED',
  COD_LIMIT_EXCEEDED: 'COD_LIMIT_EXCEEDED',
  COD_ADVANCE_REQUIRED: 'COD_ADVANCE_REQUIRED',
  ADVANCE_PAYMENT_FAILED: 'ADVANCE_PAYMENT_FAILED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  PAYMENT_VERIFICATION_FAILED: 'PAYMENT_VERIFICATION_FAILED',
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  INSUFFICIENT_WALLET_BALANCE: 'INSUFFICIENT_WALLET_BALANCE',
  PRICING_MISMATCH: 'PRICING_MISMATCH',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  ADDRESS_REQUIRED: 'ADDRESS_REQUIRED',
  MAINTENANCE: 'MAINTENANCE',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  APP_UPDATE_REQUIRED: 'APP_UPDATE_REQUIRED',
} as const;
