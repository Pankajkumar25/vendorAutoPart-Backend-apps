import { Router } from 'express';
import * as c from '../controllers/payment.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody, validateParams } from '../middleware/validate.middleware';
import { paymentLimiter } from '../middleware/rateLimit.middleware';
import { verifyPaymentSchema, simulatePaymentSchema } from '../validators/cart.validator';
import { objectId, objectIdParam } from '../validators/common.validator';
import { z } from 'zod';

/**
 * Payments (spec section 20, RULE 16).
 *
 * The webhook is deliberately NOT mounted here - it needs the raw request body
 * for signature verification and is wired directly in `app.ts` before the JSON
 * parser. Everything here is a customer-authenticated action; the amount is
 * always the server-recorded figure, never a number from the request.
 */
const router = Router();

const initiatePaymentSchema = z.object({ orderId: objectId });

router.use(authenticate);

router.get('/config', asyncHandler(c.getConfig));
router.post('/initiate', paymentLimiter, validateBody(initiatePaymentSchema), asyncHandler(c.initiatePayment));
router.post('/verify', paymentLimiter, validateBody(verifyPaymentSchema), asyncHandler(c.verifyPayment));
router.get('/order/:orderId', validateParams(objectIdParam('orderId')), asyncHandler(c.getOrderPayments));

// Dev/staging only. `simulatePayment` throws through `mockAdapter()` when the
// live gateway is Razorpay, so it is inert in production even if reachable.
router.post('/simulate', validateBody(simulatePaymentSchema), asyncHandler(c.simulatePayment));

export default router;
