import { Router } from 'express';
import * as c from '../controllers/user.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import { updateProfileSchema } from '../validators/auth.validator';

/**
 * The signed-in customer's own account (spec section 7, 8-10).
 *
 * `me/pricing` and `me/quantity-discounts` return this customer's *own*
 * negotiated deals only - the query is scoped to their token id, so one dealer
 * can never read another's prices (RULES 18, 19).
 */
const router = Router();

router.use(authenticate);

router.get('/me', asyncHandler(c.getProfile));
router.patch('/me', validateBody(updateProfileSchema), asyncHandler(c.updateProfile));
router.get('/me/summary', asyncHandler(c.getAccountSummary));
router.get('/me/pricing', asyncHandler(c.getMyPricing));
router.get('/me/quantity-discounts', asyncHandler(c.getMyQuantityDiscounts));

export default router;
