/**
 * Barrel export for every Mongoose model. Importing from here guarantees each
 * schema is registered before any `populate()` call needs it.
 */
export { User, type IUser } from './user.model';
export { Category, type ICategory } from './category.model';
export { Product, type IProduct, type IProductImage } from './product.model';
export { Address, type IAddress, type IGeoPoint } from './address.model';
export { Cart, type ICart } from './cart.model';
export { cartItemSchema, type ICartItem } from './cartItem.model';
export { Order, type IOrder, type IOrderAddress, type IOrderStatusEvent } from './order.model';
export { orderItemSchema, type IOrderItem } from './orderItem.model';
export {
  Coupon,
  CouponRedemption,
  type ICoupon,
  type ICouponRedemption,
} from './coupon.model';
export { Payment, type IPayment } from './payment.model';
export { Notification, type INotification } from './notification.model';
export { UserProductPrice, type IUserProductPrice } from './userProductPrice.model';
export { QuantityDiscountRule, type IQuantityDiscountRule } from './quantityDiscountRule.model';
export {
  UserQuantityDiscountRule,
  type IUserQuantityDiscountRule,
} from './userQuantityDiscountRule.model';
export { Wallet, WalletTransaction, type IWallet, type IWalletTransaction } from './wallet.model';
export { Settings, PUBLIC_SETTINGS_FIELDS, type ISettings, type IDeliveryZone } from './settings.model';
export { OtpToken, RefreshToken, type IOtpToken, type IRefreshToken } from './otp.model';
export {
  SearchTerm,
  UserActivity,
  MAX_RECENT_SEARCHES,
  MAX_RECENTLY_VIEWED,
  type ISearchTerm,
  type IUserActivity,
} from './searchTerm.model';
