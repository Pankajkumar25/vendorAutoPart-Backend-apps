import mongoose, { Types } from 'mongoose';
import { Cart, type ICart } from '../models/cart.model';
import { Product } from '../models/product.model';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import { PRODUCT_STATUS, type PaymentMethod } from '../config/constants';
import { calculateOrderPricing, type OrderPricingResult } from './pricing.service';

/**
 * Cart persistence (spec section 15).
 *
 * The cart stores product ids and quantities and nothing else. Every price the
 * customer sees is recomputed by the pricing engine on read, so a cart that has
 * been sitting on a device for a week automatically reflects any price,
 * discount or rule change the admin has made since (RULE 14/15).
 */

export async function getOrCreateCart(userId: string | Types.ObjectId): Promise<ICart> {
  const existing = await Cart.findOne({ userId });
  if (existing) return existing;
  try {
    return await Cart.create({ userId, items: [] });
  } catch (err) {
    // Unique index on userId: another concurrent request created it first.
    if ((err as { code?: number }).code === 11000) {
      const cart = await Cart.findOne({ userId });
      if (cart) return cart;
    }
    throw err;
  }
}

/** Priced view of the cart: active lines, saved-for-later lines and totals. */
export interface CartView {
  cartId: string;
  pricing: OrderPricingResult;
  savedForLater: {
    productId: string;
    name: string;
    partNumber: string;
    image: string | null;
    quantity: number;
    sellingPrice: number;
    mrp: number;
    inStock: boolean;
  }[];
  couponCode: string | null;
  updatedAt: Date;
}

export async function getCartView(
  userId: string | Types.ObjectId,
  options: { paymentMethod?: PaymentMethod; couponCode?: string | null; pincode?: string | null } = {},
): Promise<CartView> {
  const cart = await getOrCreateCart(userId);

  const activeItems = cart.items.filter((i) => !i.savedForLater);
  const savedItems = cart.items.filter((i) => i.savedForLater);

  // A coupon explicitly passed in wins; otherwise fall back to the one stored
  // on the cart. `null` passed in means "remove it".
  const couponCode =
    options.couponCode !== undefined ? options.couponCode : cart.couponCode ?? null;

  const pricing = await calculateOrderPricing({
    userId,
    items: activeItems.map((i) => ({ productId: String(i.productId), quantity: i.quantity })),
    couponCode,
    paymentMethod: options.paymentMethod,
    pincode: options.pincode,
    strict: false,
  });

  // Saved-for-later lines get their own lightweight pricing pass.
  let savedForLater: CartView['savedForLater'] = [];
  if (savedItems.length) {
    const savedPricing = await calculateOrderPricing({
      userId,
      items: savedItems.map((i) => ({ productId: String(i.productId), quantity: i.quantity })),
      paymentMethod: options.paymentMethod,
      strict: false,
    });
    savedForLater = savedPricing.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      partNumber: item.partNumber,
      image: item.image,
      quantity: item.quantity,
      sellingPrice: item.effectiveUnitPrice,
      mrp: item.mrp,
      inStock: item.inStock,
    }));
  }

  return {
    cartId: String(cart._id),
    pricing,
    savedForLater,
    couponCode: pricing.summary.couponApplied ? pricing.summary.couponCode : couponCode,
    updatedAt: cart.updatedAt,
  };
}

async function assertPurchasable(productId: string, quantity: number): Promise<void> {
  const product = await Product.findById(productId)
    .select('name status stock minOrderQuantity maxOrderQuantity unit')
    .lean();
  if (!product) throw ApiError.notFound('Product not found');

  if (product.status !== PRODUCT_STATUS.ACTIVE) {
    throw new ApiError(409, `${product.name} is not available`, ERROR_CODES.PRODUCT_UNAVAILABLE);
  }
  if (product.stock <= 0) {
    throw new ApiError(409, `${product.name} is out of stock`, ERROR_CODES.OUT_OF_STOCK);
  }
  if (quantity > product.stock) {
    throw new ApiError(
      409,
      `Only ${product.stock} ${product.unit ?? 'PCS'} available`,
      ERROR_CODES.INSUFFICIENT_STOCK,
      { availableStock: product.stock },
    );
  }
  const moq = product.minOrderQuantity ?? 1;
  if (quantity < moq) {
    throw new ApiError(
      422,
      `Minimum order quantity for ${product.name} is ${moq}`,
      ERROR_CODES.BELOW_MOQ,
      { minOrderQuantity: moq },
    );
  }
  if (product.maxOrderQuantity && quantity > product.maxOrderQuantity) {
    throw new ApiError(422, `You can order at most ${product.maxOrderQuantity} of ${product.name}`, 'ABOVE_MAX_QUANTITY', {
      maxOrderQuantity: product.maxOrderQuantity,
    });
  }
}

/**
 * Adds to the cart, or tops up an existing line.
 * `mode: 'set'` replaces the quantity instead (used by the stepper).
 */
export async function addToCart(
  userId: string | Types.ObjectId,
  productId: string,
  quantity: number,
  mode: 'increment' | 'set' = 'increment',
): Promise<ICart> {
  if (!mongoose.isValidObjectId(productId)) throw ApiError.badRequest('Invalid product id');
  const cart = await getOrCreateCart(userId);

  const existing = cart.items.find((i) => String(i.productId) === productId);
  const nextQuantity =
    mode === 'set' ? quantity : (existing && !existing.savedForLater ? existing.quantity : 0) + quantity;

  if (nextQuantity <= 0) return removeFromCart(userId, productId);

  await assertPurchasable(productId, nextQuantity);

  if (existing) {
    existing.quantity = nextQuantity;
    // Adding an item back moves it out of "saved for later".
    existing.savedForLater = false;
    existing.addedAt = new Date();
  } else {
    cart.items.push({
      productId: new Types.ObjectId(productId),
      quantity: nextQuantity,
      savedForLater: false,
      addedAt: new Date(),
    });
  }

  await cart.save();
  return cart;
}

export async function removeFromCart(userId: string | Types.ObjectId, productId: string): Promise<ICart> {
  const cart = await getOrCreateCart(userId);
  cart.items = cart.items.filter((i) => String(i.productId) !== productId);
  await cart.save();
  return cart;
}

export async function setSavedForLater(
  userId: string | Types.ObjectId,
  productId: string,
  saved: boolean,
): Promise<ICart> {
  const cart = await getOrCreateCart(userId);
  const item = cart.items.find((i) => String(i.productId) === productId);
  if (!item) throw ApiError.notFound('That product is not in your cart');
  if (!saved) await assertPurchasable(productId, item.quantity);
  item.savedForLater = saved;
  await cart.save();
  return cart;
}

export async function clearCart(userId: string | Types.ObjectId, includeSaved = false): Promise<ICart> {
  const cart = await getOrCreateCart(userId);
  cart.items = includeSaved ? [] : cart.items.filter((i) => i.savedForLater);
  cart.couponCode = null;
  await cart.save();
  return cart;
}

/** Stores the typed coupon code. Validation happens at pricing time, not here. */
export async function setCartCoupon(
  userId: string | Types.ObjectId,
  couponCode: string | null,
): Promise<ICart> {
  const cart = await getOrCreateCart(userId);
  cart.couponCode = couponCode ? couponCode.trim().toUpperCase() : null;
  await cart.save();
  return cart;
}

/**
 * Drops lines whose product has been deleted or deactivated, and trims
 * quantities down to available stock. Called after checkout failures so the
 * customer is not stuck on a screen they cannot get past.
 */
export async function reconcileCart(userId: string | Types.ObjectId): Promise<{ removed: string[]; adjusted: string[] }> {
  const cart = await getOrCreateCart(userId);
  if (!cart.items.length) return { removed: [], adjusted: [] };

  const products = await Product.find({ _id: { $in: cart.items.map((i) => i.productId) } })
    .select('status stock minOrderQuantity')
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  const removed: string[] = [];
  const adjusted: string[] = [];

  cart.items = cart.items.filter((item) => {
    const product = byId.get(String(item.productId));
    if (!product || product.status !== PRODUCT_STATUS.ACTIVE || product.stock <= 0) {
      removed.push(String(item.productId));
      return false;
    }
    if (item.quantity > product.stock) {
      item.quantity = product.stock;
      adjusted.push(String(item.productId));
    }
    const moq = product.minOrderQuantity ?? 1;
    if (item.quantity < moq) {
      if (product.stock >= moq) {
        item.quantity = moq;
        adjusted.push(String(item.productId));
      } else {
        removed.push(String(item.productId));
        return false;
      }
    }
    return true;
  });

  if (removed.length || adjusted.length) await cart.save();
  return { removed, adjusted };
}

/** Badge count for the tab bar - active lines only. */
export async function getCartCount(userId: string | Types.ObjectId): Promise<number> {
  const cart = await Cart.findOne({ userId }).select('items').lean();
  if (!cart) return 0;
  return cart.items.filter((i) => !i.savedForLater).length;
}
