import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import * as c from '../controllers/checkout.controller';

const router = Router();

/**
 * Payment-first checkout routes.
 *
 * POST /initiate — validate + reserve stock + create Razorpay order
 * POST /confirm  — verify payment + create real Order
 */

router.post(
  '/initiate',
  authenticate,
  asyncHandler(c.initiateCheckout),
);

router.post(
  '/confirm',
  authenticate,
  asyncHandler(c.confirmCheckout),
);

export default router;
