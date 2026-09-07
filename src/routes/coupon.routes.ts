import { Router } from 'express';
import * as c from '../controllers/coupon.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { applyCouponSchema } from '../validators/cart.validator';

/**
 * Coupons, customer side (spec sections 16, 17). Private coupons issued to one
 * dealer are filtered by `allowedUsers` in the service, so another dealer never
 * sees them. The ONLINE-only rule (RULE 9/10) is enforced at evaluation time,
 * not here.
 */
const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(c.listCoupons));
router.get('/applicable', asyncHandler(c.listApplicableCoupons));
router.post('/validate', validateBody(applyCouponSchema), asyncHandler(c.validateCoupon));

export default router;
