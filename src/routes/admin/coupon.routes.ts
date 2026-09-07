import { Router } from 'express';
import * as c from '../../controllers/admin/adminCoupon.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateBody, validateParams, validateQuery } from '../../middleware/validate.middleware';
import { objectIdParam } from '../../validators/common.validator';
import { couponListQuery, createCouponSchema, updateCouponSchema } from '../../validators/admin.validator';

/**
 * Coupon administration (spec sections 16, 17).
 *
 * The ONLINE-only / never-COD invariant (RULE 9/10) is not a field on any of
 * these payloads - it is enforced in `coupon.service` at redemption time, so no
 * amount of admin editing here can enable a coupon for a cash order. A coupon
 * that has already been redeemed is deactivated rather than deleted, preserving
 * the orders that reference it.
 */
const router = Router();
const idParam = objectIdParam('id');

router.get('/', requirePermission('coupons.read'), validateQuery(couponListQuery), asyncHandler(c.listCoupons));
router.post('/', requirePermission('coupons.write'), validateBody(createCouponSchema), asyncHandler(c.createCoupon));

router.get('/:id', requirePermission('coupons.read'), validateParams(idParam), asyncHandler(c.getCoupon));
router.patch(
  '/:id',
  requirePermission('coupons.write'),
  validate({ params: idParam, body: updateCouponSchema }),
  asyncHandler(c.updateCoupon),
);
router.delete('/:id', requirePermission('coupons.write'), validateParams(idParam), asyncHandler(c.deleteCoupon));

export default router;
