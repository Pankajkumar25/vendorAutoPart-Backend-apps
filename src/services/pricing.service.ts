import { Types } from 'mongoose';
import { Product, type IProduct } from '../models/product.model';
import type { ISettings } from '../models/settings.model';
import {
  PAYMENT_METHODS,
  PRODUCT_STATUS,
  type PaymentMethod,
} from '../config/constants';
import { ApiError, ERROR_CODES } from '../utils/apiError';
import {
  distributeProportionally,
  money,
  percentOfPaise,
  toPaise,
  toRupees,
} from '../utils/money';
import { getSettings } from './settings.service';
import { getUserPriceMap, resolveEffectiveUnitPrice } from './userPricing.service';
import {
  loadDiscountContext,
  previewLadder,
  resolveQuantityDiscount,
  type DiscountRuleTier,
  type LoadedDiscountContext,
} from './quantityDiscount.service';
import { tryEvaluateCoupon, type CouponFailure } from './coupon.service';
import { calculateDelivery } from './delivery.service';
import { computeLineTax, summariseTaxByRate } from './tax.service';
import { codEvaluationToRupees, evaluateCod } from './cod.service';

/**
 * THE PRICING ENGINE - the single source of truth for every rupee this system
 * quotes or charges (spec sections 14, 35, 39, 40).
 *
 * Order of operations, applied per spec section 40:
 *
 *   base price
 *     -> customer-specific price          (overrides base)
 *     -> quantity discount                (highest qualifying tier only)
 *     -> coupon                           (ONLINE payment only)
 *     -> GST
 *     -> delivery
 *     -> final total
 *     -> COD eligibility + advance
 *
 * Two invariants hold everywhere in this file:
 *
 *   1. NOTHING is read from the request body except product ids, quantities, a
 *      coupon *code*, and the chosen payment method. Every price, percentage,
 *      discount and total is looked up or derived server-side. A client that
 *      posts `{ price: 1 }` is ignored, not trusted (RULE 15).
 *
 *   2. All arithmetic runs in integer paise and is converted to rupees only at
 *      the boundary, so the app, the invoice and the payment gateway can never
 *      disagree by a rounding paisa.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuantityDiscountView {
  percentage: number;
  amount: number;
  scope: string | null;
  ruleId: string | null;
  minimumQuantity: number | null;
  label?: string | null;
  /** Full ladder in force, e.g. [{3, 2%}, {6, 6%}]. */
  tiers: { minimumQuantity: number; discountPercentage: number }[];
  /** Nearest tier not yet reached, for "add 3 more to save 6%" hints. */
  nextTier: { minimumQuantity: number; discountPercentage: number; unitsAway: number } | null;
}

export interface ProductPriceBreakdown {
  productId: string;
  name: string;
  sku: string;
  partNumber: string;
  brand: string;
  image: string | null;
  categoryId: string | null;
  unit: string;

  /** Printed MRP - display only, never used as a charge basis. */
  mrp: number;
  /** Product default price. */
  basePrice: number;
  /** Customer-specific price, or null when they have none. */
  userPrice: number | null;
  hasCustomPrice: boolean;
  /** What the customer pays per unit before the quantity discount. */
  effectiveUnitPrice: number;
  /** Effective unit price after the quantity discount, for display. */
  discountedUnitPrice: number;

  quantity: number;
  quantityDiscount: QuantityDiscountView;

  /** effectiveUnitPrice * quantity. */
  grossAmount: number;
  /** grossAmount - quantity discount. */
  lineSubtotal: number;

  gstRate: number;
  weight: number;
  stock: number;
  minOrderQuantity: number;
  maxOrderQuantity: number | null;
  inStock: boolean;

  /** (mrp - effectiveUnitPrice) * qty, floored at 0. */
  savingsVsMrp: number;
  /** Percentage off MRP, for the discount badge on product cards. */
  discountPercentVsMrp: number;
}

export interface PricingIssue {
  productId: string;
  productName?: string;
  code: string;
  message: string;
  /** Quantity that *would* be acceptable, when the issue is a bound violation. */
  suggestedQuantity?: number;
}

export interface OrderPricingSummary {
  itemsGross: number;
  quantityDiscountTotal: number;
  itemsSubtotal: number;

  couponCode: string | null;
  couponId: string | null;
  couponApplied: boolean;
  couponDiscount: number;
  couponFailure: CouponFailure | null;

  taxableAmount: number;
  gstTotal: number;
  gstBreakup: { rate: number; taxableAmount: number; gstAmount: number }[];

  deliveryCharge: number;
  deliveryReason: string;
  deliveryIsFree: boolean;
  freeDeliveryShortfall: number | null;
  estimatedDeliveryDays: number;

  grandTotal: number;
  totalSavings: number;
  totalQuantity: number;
  totalWeightGrams: number;
  itemCount: number;
}

export interface OrderPricingResult {
  items: (ProductPriceBreakdown & {
    couponDiscountShare: number;
    taxableAmount: number;
    gstAmount: number;
    lineTotal: number;
  })[];
  summary: OrderPricingSummary;
  cod: ReturnType<typeof codEvaluationToRupees>;
  payment: {
    method: PaymentMethod;
    /** Charged through the gateway right now. */
    payableNow: number;
    /** Collected in cash at the door. 0 for online orders. */
    payableOnDelivery: number;
  };
  issues: PricingIssue[];
  /** Snapshot of the rules this quote was produced under. */
  context: {
    gstMode: string;
    quantityDiscountResolution: string;
    couponsAllowedForPaymentMethod: boolean;
    pricedAt: string;
  };
}

export interface OrderPricingInput {
  userId: string | Types.ObjectId;
  items: { productId: string; quantity: number }[];
  couponCode?: string | null;
  paymentMethod?: PaymentMethod;
  /** Delivery pincode, when known, so zone rules can apply. */
  pincode?: string | null;
  /**
   * `true` during order creation: any stock/MOQ/availability problem throws.
   * `false` for cart and checkout previews: problems come back in `issues` so
   * the customer can see and fix them.
   */
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierView(tiers: DiscountRuleTier[]) {
  return tiers.map((t) => ({ minimumQuantity: t.minimumQuantity, discountPercentage: t.discountPercentage }));
}

function primaryImageOf(product: Pick<IProduct, 'images'>): string | null {
  if (!product.images?.length) return null;
  return (product.images.find((i) => i.isPrimary) ?? product.images[0]).url ?? null;
}

function discountPercentVsMrp(mrp: number, price: number): number {
  if (mrp <= 0 || price >= mrp) return 0;
  return Math.round(((mrp - price) / mrp) * 100);
}

/** Products are loaded lean but we need the same shape everywhere. */
type LeanProduct = Pick<
  IProduct,
  | 'name'
  | 'sku'
  | 'partNumber'
  | 'brand'
  | 'images'
  | 'unit'
  | 'mrp'
  | 'basePrice'
  | 'stock'
  | 'minOrderQuantity'
  | 'maxOrderQuantity'
  | 'weight'
  | 'gstRate'
  | 'status'
  | 'category'
> & { _id: Types.ObjectId };

const PRODUCT_PRICING_FIELDS =
  'name sku partNumber brand images unit mrp basePrice stock minOrderQuantity maxOrderQuantity weight gstRate status category';

/**
 * Builds a single line breakdown. Pure once the product, custom price and
 * discount context are in hand.
 */
function buildLine(
  product: LeanProduct,
  quantity: number,
  userPrice: number | null,
  discountContext: LoadedDiscountContext,
  settings: ISettings,
): ProductPriceBreakdown {
  const categoryId = product.category ? String(product.category) : null;
  const resolvedPrice = resolveEffectiveUnitPrice(product.basePrice, userPrice);

  const unitPaise = toPaise(resolvedPrice.effectiveUnitPrice);
  const grossPaise = unitPaise * quantity;

  const discount = resolveQuantityDiscount(
    discountContext,
    { productId: String(product._id), categoryId },
    quantity,
  );

  // RULE 6/7: applied per product, and only the single highest qualifying tier.
  const discountPaise = percentOfPaise(grossPaise, discount.discountPercentage);
  const lineSubtotalPaise = grossPaise - discountPaise;

  const mrp = money(product.mrp);
  const savingsVsMrpPaise = Math.max(0, (toPaise(mrp) - unitPaise) * quantity);

  return {
    productId: String(product._id),
    name: product.name,
    sku: product.sku,
    partNumber: product.partNumber,
    brand: product.brand,
    image: primaryImageOf(product),
    categoryId,
    unit: product.unit ?? 'PCS',

    mrp,
    basePrice: resolvedPrice.basePrice,
    userPrice: resolvedPrice.userPrice,
    hasCustomPrice: resolvedPrice.hasCustomPrice,
    effectiveUnitPrice: resolvedPrice.effectiveUnitPrice,
    discountedUnitPrice: quantity > 0 ? toRupees(Math.round(lineSubtotalPaise / quantity)) : resolvedPrice.effectiveUnitPrice,

    quantity,
    quantityDiscount: {
      percentage: discount.discountPercentage,
      amount: toRupees(discountPaise),
      scope: discount.scope,
      ruleId: discount.ruleId ? String(discount.ruleId) : null,
      minimumQuantity: discount.minimumQuantity,
      label: discount.label ?? null,
      tiers: tierView(discount.activeLadder),
      nextTier: discount.nextTier
        ? {
            minimumQuantity: discount.nextTier.minimumQuantity,
            discountPercentage: discount.nextTier.discountPercentage,
            unitsAway: discount.nextTier.minimumQuantity - quantity,
          }
        : null,
    },

    grossAmount: toRupees(grossPaise),
    lineSubtotal: toRupees(lineSubtotalPaise),

    gstRate: product.gstRate ?? settings.defaultGstRate,
    weight: product.weight ?? 0,
    stock: product.stock,
    minOrderQuantity: product.minOrderQuantity ?? 1,
    maxOrderQuantity: product.maxOrderQuantity ?? null,
    inStock: product.stock > 0,

    savingsVsMrp: toRupees(savingsVsMrpPaise),
    discountPercentVsMrp: discountPercentVsMrp(mrp, resolvedPrice.effectiveUnitPrice),
  };
}

/** Availability / bounds checks shared by preview and strict order creation. */
function collectLineIssues(product: LeanProduct, quantity: number): PricingIssue[] {
  const issues: PricingIssue[] = [];
  const id = String(product._id);

  if (product.status !== PRODUCT_STATUS.ACTIVE) {
    issues.push({
      productId: id,
      productName: product.name,
      code: ERROR_CODES.PRODUCT_UNAVAILABLE,
      message: `${product.name} is no longer available`,
    });
    return issues;
  }

  if (product.stock <= 0) {
    issues.push({
      productId: id,
      productName: product.name,
      code: ERROR_CODES.OUT_OF_STOCK,
      message: `${product.name} is out of stock`,
      suggestedQuantity: 0,
    });
    return issues;
  }

  if (quantity > product.stock) {
    issues.push({
      productId: id,
      productName: product.name,
      code: ERROR_CODES.INSUFFICIENT_STOCK,
      message: `Only ${product.stock} ${product.unit ?? 'PCS'} of ${product.name} left in stock`,
      suggestedQuantity: product.stock,
    });
  }

  const moq = product.minOrderQuantity ?? 1;
  if (quantity < moq) {
    issues.push({
      productId: id,
      productName: product.name,
      code: ERROR_CODES.BELOW_MOQ,
      message: `${product.name} has a minimum order quantity of ${moq}`,
      suggestedQuantity: moq,
    });
  }

  if (product.maxOrderQuantity && quantity > product.maxOrderQuantity) {
    issues.push({
      productId: id,
      productName: product.name,
      code: 'ABOVE_MAX_QUANTITY',
      message: `You can order at most ${product.maxOrderQuantity} of ${product.name}`,
      suggestedQuantity: product.maxOrderQuantity,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Public API: single product
// ---------------------------------------------------------------------------

/**
 * Spec section 14: `calculateProductPrice({ userId, productId, quantity })`.
 *
 * Returns the complete breakdown for one product at one quantity - MRP, base
 * price, customer price, discount percentage and amount, final unit price and
 * line total.
 */
export async function calculateProductPrice(params: {
  userId: string | Types.ObjectId | null;
  productId: string | Types.ObjectId;
  quantity?: number;
}): Promise<ProductPriceBreakdown> {
  const quantity = Math.max(1, Math.floor(params.quantity ?? 1));

  const product = await Product.findById(params.productId).select(PRODUCT_PRICING_FIELDS).lean<LeanProduct>();
  if (!product) throw ApiError.notFound('Product not found');

  const settings = await getSettings();
  const [priceMap, discountContext] = await Promise.all([
    params.userId ? getUserPriceMap(params.userId, [product._id]) : Promise.resolve(new Map<string, number>()),
    loadDiscountContext(
      params.userId ?? null,
      [{ productId: product._id, categoryId: product.category }],
      settings.quantityDiscountResolution,
    ),
  ]);

  return buildLine(
    product,
    quantity,
    priceMap.get(String(product._id)) ?? null,
    discountContext,
    settings,
  );
}

// ---------------------------------------------------------------------------
// Public API: product listings
// ---------------------------------------------------------------------------

export interface ListingPrice {
  productId: string;
  mrp: number;
  basePrice: number;
  userPrice: number | null;
  hasCustomPrice: boolean;
  /** The one number the product card shows as "Your Price". */
  sellingPrice: number;
  savingsVsMrp: number;
  discountPercentVsMrp: number;
  /** Ladder preview so the card can show "Buy 6+ and get 6% OFF". */
  quantityTiers: { minimumQuantity: number; discountPercentage: number }[];
}

/**
 * Resolves display prices for a page of products in a fixed number of queries
 * (one for custom prices, one for user rules, one for global rules) no matter
 * how many products are on the page.
 *
 * Every product-listing endpoint routes through this, which is what makes
 * spec section 43 true: the customer never picks a price list, their JWT
 * decides it.
 */
export async function attachListingPrices(
  userId: string | Types.ObjectId | null,
  products: { _id: Types.ObjectId; mrp: number; basePrice: number; category?: Types.ObjectId | null }[],
): Promise<Map<string, ListingPrice>> {
  const out = new Map<string, ListingPrice>();
  if (!products.length) return out;

  const settings = await getSettings();
  const [priceMap, discountContext] = await Promise.all([
    userId ? getUserPriceMap(userId, products.map((p) => p._id)) : Promise.resolve(new Map<string, number>()),
    loadDiscountContext(
      userId ?? null,
      products.map((p) => ({ productId: p._id, categoryId: p.category ?? null })),
      settings.quantityDiscountResolution,
    ),
  ]);

  for (const product of products) {
    const id = String(product._id);
    const resolved = resolveEffectiveUnitPrice(product.basePrice, priceMap.get(id) ?? null);
    const ladder = previewLadder(discountContext, { productId: product._id, categoryId: product.category ?? null });

    out.set(id, {
      productId: id,
      mrp: money(product.mrp),
      basePrice: resolved.basePrice,
      userPrice: resolved.userPrice,
      hasCustomPrice: resolved.hasCustomPrice,
      sellingPrice: resolved.effectiveUnitPrice,
      savingsVsMrp: money(Math.max(0, product.mrp - resolved.effectiveUnitPrice)),
      discountPercentVsMrp: discountPercentVsMrp(money(product.mrp), resolved.effectiveUnitPrice),
      quantityTiers: tierView(ladder),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API: whole order
// ---------------------------------------------------------------------------

/**
 * Spec section 39: `calculateOrderPricing(userId, cartItems, couponCode, paymentMethod)`.
 *
 * The one function used by cart display, checkout preview, order creation and
 * post-payment verification. Because all four call the same code, a customer
 * cannot see one total and be charged another.
 */
export async function calculateOrderPricing(input: OrderPricingInput): Promise<OrderPricingResult> {
  const paymentMethod = input.paymentMethod ?? PAYMENT_METHODS.ONLINE;
  const strict = input.strict ?? false;
  const settings = await getSettings();

  const requested = input.items
    .map((item) => ({ productId: String(item.productId), quantity: Math.floor(Number(item.quantity)) }))
    .filter((item) => item.quantity > 0);

  if (!requested.length) {
    if (strict) throw new ApiError(400, 'Your cart is empty', ERROR_CODES.CART_EMPTY);
    return emptyPricing(paymentMethod, settings);
  }

  // Collapse duplicate lines so a cart with the same product twice is priced -
  // and quantity-discounted - as a single 2x line rather than two 1x lines.
  const mergedQty = new Map<string, number>();
  for (const item of requested) {
    mergedQty.set(item.productId, (mergedQty.get(item.productId) ?? 0) + item.quantity);
  }

  const productIds = [...mergedQty.keys()];
  const products = await Product.find({ _id: { $in: productIds } })
    .select(PRODUCT_PRICING_FIELDS)
    .lean<LeanProduct[]>();

  const productById = new Map(products.map((p) => [String(p._id), p]));

  const issues: PricingIssue[] = [];
  for (const id of productIds) {
    if (!productById.has(id)) {
      issues.push({
        productId: id,
        code: ERROR_CODES.PRODUCT_UNAVAILABLE,
        message: 'A product in your cart is no longer available',
      });
    }
  }

  const [priceMap, discountContext] = await Promise.all([
    getUserPriceMap(input.userId, productIds),
    loadDiscountContext(
      input.userId,
      products.map((p) => ({ productId: p._id, categoryId: p.category })),
      settings.quantityDiscountResolution,
    ),
  ]);

  // --- Step 1-8: per-line pricing --------------------------------------------
  const lines: ProductPriceBreakdown[] = [];
  for (const [productId, quantity] of mergedQty) {
    const product = productById.get(productId);
    if (!product) continue;
    issues.push(...collectLineIssues(product, quantity));
    lines.push(buildLine(product, quantity, priceMap.get(productId) ?? null, discountContext, settings));
  }

  if (strict && issues.length) {
    const first = issues[0];
    throw new ApiError(409, first.message, first.code, { issues });
  }

  if (!lines.length) {
    if (strict) throw new ApiError(400, 'Your cart is empty', ERROR_CODES.CART_EMPTY);
    return { ...emptyPricing(paymentMethod, settings), issues };
  }

  const grossPaiseByLine = lines.map((l) => toPaise(l.grossAmount));
  const subtotalPaiseByLine = lines.map((l) => toPaise(l.lineSubtotal));

  const itemsGrossPaise = grossPaiseByLine.reduce((a, b) => a + b, 0);
  const itemsSubtotalPaise = subtotalPaiseByLine.reduce((a, b) => a + b, 0);
  const quantityDiscountPaise = itemsGrossPaise - itemsSubtotalPaise;

  // --- Step 10: coupon, ONLINE only ----------------------------------------
  const couponsAllowed = paymentMethod === PAYMENT_METHODS.ONLINE;
  let couponDiscountPaise = 0;
  let couponId: string | null = null;
  let appliedCode: string | null = null;
  let couponFailure: CouponFailure | null = null;
  let eligibleLineFlags: boolean[] = lines.map(() => true);

  const requestedCode = input.couponCode?.trim().toUpperCase() || null;

  if (requestedCode) {
    const evaluation = await tryEvaluateCoupon({
      code: requestedCode,
      userId: input.userId,
      paymentMethod,
      orderValuePaise: itemsSubtotalPaise,
      lines: lines.map((l, i) => ({
        productId: l.productId,
        categoryId: l.categoryId,
        linePaise: subtotalPaiseByLine[i],
      })),
    });

    if (evaluation.result) {
      const { coupon, discountPaise } = evaluation.result;
      couponDiscountPaise = discountPaise;
      couponId = String(coupon._id);
      appliedCode = coupon.code;

      const productSet = coupon.applicableProducts?.length
        ? new Set(coupon.applicableProducts.map(String))
        : null;
      const categorySet = coupon.applicableCategories?.length
        ? new Set(coupon.applicableCategories.map(String))
        : null;
      if (productSet || categorySet) {
        eligibleLineFlags = lines.map(
          (l) =>
            (productSet?.has(l.productId) ?? false) ||
            (l.categoryId ? categorySet?.has(l.categoryId) ?? false : false),
        );
      }
    } else {
      couponFailure = evaluation.failure;
      // In strict mode a coupon the customer explicitly chose must not be
      // silently dropped - they would be charged more than the screen showed.
      if (strict && couponFailure) {
        throw new ApiError(422, couponFailure.message, couponFailure.code);
      }
    }
  }

  // Apportion the coupon across the lines it applies to, in proportion to line
  // value, with the paise remainder distributed so the parts sum exactly.
  const couponWeights = subtotalPaiseByLine.map((paise, i) => (eligibleLineFlags[i] ? paise : 0));
  const couponShares = distributeProportionally(couponDiscountPaise, couponWeights);

  // --- Step 11: GST --------------------------------------------------------
  const pricedLines = lines.map((line, i) => {
    const taxableBasePaise = Math.max(0, subtotalPaiseByLine[i] - couponShares[i]);
    const tax = computeLineTax({ taxableBasePaise, gstRate: line.gstRate }, settings.gstMode);
    return {
      ...line,
      couponDiscountShare: toRupees(couponShares[i]),
      taxableAmount: toRupees(tax.taxablePaise),
      gstAmount: toRupees(tax.gstPaise),
      lineTotal: toRupees(tax.linePaise),
      _taxablePaise: tax.taxablePaise,
      _gstPaise: tax.gstPaise,
      _linePaise: tax.linePaise,
    };
  });

  const gstTotalPaise = pricedLines.reduce((sum, l) => sum + l._gstPaise, 0);
  const taxableTotalPaise = pricedLines.reduce((sum, l) => sum + l._taxablePaise, 0);
  const lineTotalPaise = pricedLines.reduce((sum, l) => sum + l._linePaise, 0);

  // --- Step 12: delivery ---------------------------------------------------
  const totalWeightGrams = lines.reduce((sum, l) => sum + (l.weight ?? 0) * l.quantity, 0);
  // The free-shipping threshold is measured on net merchandise value: after
  // discounts, before tax and before the delivery charge itself.
  const merchandisePaise = Math.max(0, itemsSubtotalPaise - couponDiscountPaise);
  const delivery = calculateDelivery({ merchandisePaise, totalWeightGrams, pincode: input.pincode }, settings);

  // --- Step 13: grand total ------------------------------------------------
  const grandTotalPaise = Math.max(0, lineTotalPaise + delivery.chargePaise);

  // --- Steps 14-16: COD eligibility, advance and balance -------------------
  const cod = evaluateCod(
    { grandTotalPaise, hasCoupon: couponDiscountPaise > 0 },
    settings,
  );

  if (strict && paymentMethod === PAYMENT_METHODS.COD && !cod.available) {
    throw new ApiError(422, cod.reason ?? 'Cash on delivery is not available for this order', cod.reasonCode ?? ERROR_CODES.COD_DISABLED);
  }

  const savingsVsMrpPaise = lines.reduce((sum, l) => sum + toPaise(l.savingsVsMrp), 0);
  const totalSavingsPaise = savingsVsMrpPaise + quantityDiscountPaise + couponDiscountPaise;

  const isCod = paymentMethod === PAYMENT_METHODS.COD;
  const payableNowPaise = isCod ? cod.advancePaise : grandTotalPaise;
  const payableOnDeliveryPaise = isCod ? Math.max(0, grandTotalPaise - cod.advancePaise) : 0;

  const summary: OrderPricingSummary = {
    itemsGross: toRupees(itemsGrossPaise),
    quantityDiscountTotal: toRupees(quantityDiscountPaise),
    itemsSubtotal: toRupees(itemsSubtotalPaise),

    couponCode: appliedCode ?? (requestedCode && couponFailure ? requestedCode : null),
    couponId,
    couponApplied: couponDiscountPaise > 0,
    couponDiscount: toRupees(couponDiscountPaise),
    couponFailure,

    taxableAmount: toRupees(taxableTotalPaise),
    gstTotal: toRupees(gstTotalPaise),
    gstBreakup: summariseTaxByRate(
      pricedLines.map((l) => ({ gstRate: l.gstRate, gstAmount: l.gstAmount, taxableAmount: l.taxableAmount })),
    ),

    deliveryCharge: toRupees(delivery.chargePaise),
    deliveryReason: delivery.reason,
    deliveryIsFree: delivery.isFree,
    freeDeliveryShortfall:
      delivery.freeDeliveryShortfallPaise != null && delivery.freeDeliveryShortfallPaise > 0
        ? toRupees(delivery.freeDeliveryShortfallPaise)
        : null,
    estimatedDeliveryDays: delivery.estimatedDays,

    grandTotal: toRupees(grandTotalPaise),
    totalSavings: toRupees(totalSavingsPaise),
    totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
    totalWeightGrams,
    itemCount: lines.length,
  };

  return {
    // Strip the internal paise fields from the public shape.
    items: pricedLines.map(({ _taxablePaise, _gstPaise, _linePaise, ...rest }) => rest),
    summary,
    cod: codEvaluationToRupees(cod),
    payment: {
      method: paymentMethod,
      payableNow: toRupees(payableNowPaise),
      payableOnDelivery: toRupees(payableOnDeliveryPaise),
    },
    issues,
    context: {
      gstMode: settings.gstMode,
      quantityDiscountResolution: settings.quantityDiscountResolution,
      couponsAllowedForPaymentMethod: couponsAllowed,
      pricedAt: new Date().toISOString(),
    },
  };
}

function emptyPricing(paymentMethod: PaymentMethod, settings: ISettings): OrderPricingResult {
  const cod = evaluateCod({ grandTotalPaise: 0, hasCoupon: false }, settings);
  return {
    items: [],
    summary: {
      itemsGross: 0,
      quantityDiscountTotal: 0,
      itemsSubtotal: 0,
      couponCode: null,
      couponId: null,
      couponApplied: false,
      couponDiscount: 0,
      couponFailure: null,
      taxableAmount: 0,
      gstTotal: 0,
      gstBreakup: [],
      deliveryCharge: 0,
      deliveryReason: '',
      deliveryIsFree: true,
      freeDeliveryShortfall: null,
      estimatedDeliveryDays: settings.estimatedDeliveryDays,
      grandTotal: 0,
      totalSavings: 0,
      totalQuantity: 0,
      totalWeightGrams: 0,
      itemCount: 0,
    },
    cod: codEvaluationToRupees({ ...cod, available: false }),
    payment: { method: paymentMethod, payableNow: 0, payableOnDelivery: 0 },
    issues: [],
    context: {
      gstMode: settings.gstMode,
      quantityDiscountResolution: settings.quantityDiscountResolution,
      couponsAllowedForPaymentMethod: paymentMethod === PAYMENT_METHODS.ONLINE,
      pricedAt: new Date().toISOString(),
    },
  };
}

/**
 * Guards against a client that quotes a total back to us. Used by the order
 * endpoint when the app *optionally* echoes the total it displayed: a mismatch
 * means the customer saw a stale price, so we refuse rather than silently
 * charging a different amount (RULE 15).
 */
export function assertQuotedTotalMatches(expected: number | undefined, actual: number): void {
  if (expected === undefined || expected === null) return;
  if (Math.abs(toPaise(expected) - toPaise(actual)) > 0) {
    throw new ApiError(
      409,
      'Prices have changed since you opened this page. Please review your order and try again.',
      ERROR_CODES.PRICING_MISMATCH,
      { quotedTotal: money(expected), actualTotal: money(actual) },
    );
  }
}
