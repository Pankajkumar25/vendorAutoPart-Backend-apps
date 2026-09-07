import type { Request, Response } from 'express';
import { Coupon, CouponRedemption } from '../../models/coupon.model';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok, created, paginated, noContent } from '../../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/apiError';
import { escapeRegex } from '../../utils/slug';

/**
 * Coupon administration (spec section 16).
 *
 * The one invariant this screen cannot override: coupons are ONLINE-only and
 * never apply to COD (RULE 9/10). That is enforced in `coupon.service` at
 * redemption time and is deliberately not a field here, so no amount of admin
 * configuration can switch it on for cash orders.
 */

function serialize(coupon: Record<string, unknown>) {
  const expiry = coupon.expiryDate as Date | null | undefined;
  return {
    id: String(coupon._id),
    code: coupon.code,
    title: coupon.title ?? null,
    description: coupon.description ?? null,
    discountType: coupon.discountType,
    discountPercentage: coupon.discountPercentage,
    discountAmount: coupon.discountAmount,
    minOrderValue: coupon.minOrderValue,
    maxDiscountAmount: coupon.maxDiscountAmount ?? null,
    startDate: coupon.startDate ?? null,
    expiryDate: expiry ?? null,
    usageLimit: coupon.usageLimit ?? null,
    perUserUsageLimit: coupon.perUserUsageLimit ?? null,
    usedCount: coupon.usedCount ?? 0,
    allowedUsers: ((coupon.allowedUsers as unknown[]) ?? []).map(String),
    applicableCategories: ((coupon.applicableCategories as unknown[]) ?? []).map(String),
    applicableProducts: ((coupon.applicableProducts as unknown[]) ?? []).map(String),
    isPublic: coupon.isPublic,
    isActive: coupon.isActive,
    isExpired: expiry ? expiry.getTime() <= Date.now() : false,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

export async function listCoupons(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);
  const now = new Date();

  const filter: Record<string, unknown> = {};
  if (query.active === true) filter.isActive = true;
  else if (query.active === false) filter.isActive = false;

  // Expiry and text search each contribute an $or; AND them together so one
  // does not overwrite the other.
  const and: Record<string, unknown>[] = [];
  if (query.expired === true) and.push({ expiryDate: { $ne: null, $lte: now } });
  else if (query.expired === false) and.push({ $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }] });

  if (typeof query.q === 'string' && query.q.trim()) {
    const rx = new RegExp(escapeRegex(query.q.trim()), 'i');
    and.push({ $or: [{ code: rx }, { title: rx }] });
  }
  if (and.length) filter.$and = and;

  const [rows, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Coupon.countDocuments(filter),
  ]);

  paginated(res, rows.map(serialize), buildPaginationMeta(page, limit, total));
}

export async function getCoupon(req: Request, res: Response): Promise<void> {
  const coupon = await Coupon.findById(req.params.id).lean();
  if (!coupon) throw ApiError.notFound('Coupon not found');

  const [redemptions, uniqueUsers] = await Promise.all([
    CouponRedemption.countDocuments({ couponId: coupon._id }),
    CouponRedemption.distinct('userId', { couponId: coupon._id }),
  ]);

  ok(res, { ...serialize(coupon), stats: { redemptions, uniqueUsers: uniqueUsers.length } });
}

export async function createCoupon(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const code = String(req.body.code).toUpperCase();

  const clash = await Coupon.findOne({ code }).select('_id').lean();
  if (clash) throw ApiError.conflict('A coupon with this code already exists');

  const coupon = await Coupon.create({ ...req.body, code, createdBy: actor.userId });
  created(res, serialize(coupon.toObject() as unknown as Record<string, unknown>), 'Coupon created');
}

export async function updateCoupon(req: Request, res: Response): Promise<void> {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw ApiError.notFound('Coupon not found');

  const body = req.body as Record<string, unknown>;
  if (body.code) {
    const code = String(body.code).toUpperCase();
    if (code !== coupon.code) {
      const clash = await Coupon.findOne({ code, _id: { $ne: coupon._id } }).select('_id').lean();
      if (clash) throw ApiError.conflict('A coupon with this code already exists');
    }
    body.code = code;
  }

  Object.assign(coupon, body);
  await coupon.save();
  ok(res, serialize(coupon.toObject() as unknown as Record<string, unknown>), 'Coupon updated');
}

/**
 * A coupon that has already been redeemed is deactivated rather than deleted,
 * so the redemption history (and the orders that reference it) stay intact. An
 * unused coupon is safe to remove outright.
 */
export async function deleteCoupon(req: Request, res: Response): Promise<void> {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon) throw ApiError.notFound('Coupon not found');

  const redeemed = await CouponRedemption.exists({ couponId: coupon._id });
  if (redeemed || coupon.usedCount > 0) {
    coupon.isActive = false;
    await coupon.save();
    ok(res, serialize(coupon.toObject() as unknown as Record<string, unknown>), 'Coupon has been used before, so it was deactivated instead of deleted');
    return;
  }

  await coupon.deleteOne();
  noContent(res);
}
