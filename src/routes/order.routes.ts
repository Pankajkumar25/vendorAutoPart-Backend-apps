import { Router } from 'express';
import { z } from 'zod';
import * as c from '../controllers/order.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody, validateQuery } from '../middleware/validate.middleware';
import { orderLimiter } from '../middleware/rateLimit.middleware';
import { checkoutPreviewSchema, createOrderSchema, cancelOrderSchema } from '../validators/cart.validator';
import { paginationQuery } from '../validators/common.validator';
import { ORDER_STATUS, PAYMENT_METHODS } from '../config/constants';

/**
 * Orders, customer side (spec sections 21-26).
 *
 * `:id` accepts either an ObjectId or an order number, so it is not validated as
 * an ObjectId here - the controller scopes the lookup to the caller's own orders
 * either way. Placing an order is rate-limited to blunt accidental double-taps
 * and abuse; the price is always recomputed server-side (RULES 14-16).
 */
const router = Router();

// Customer order-history filters. Kept local because it is only ever these few
// fields; the heavy admin order query lives in admin.validator.
const orderListQuery = paginationQuery.extend({
  status: z.nativeEnum(ORDER_STATUS).optional(),
  paymentMethod: z.nativeEnum(PAYMENT_METHODS).optional(),
  search: z.string().trim().max(120).optional(),
});

router.use(authenticate);

router.post('/checkout/preview', validateBody(checkoutPreviewSchema), asyncHandler(c.getCheckoutPreview));
router.post('/', orderLimiter, validateBody(createOrderSchema), asyncHandler(c.placeOrder));
router.get('/', validateQuery(orderListQuery), asyncHandler(c.listMyOrders));

router.get('/:id', asyncHandler(c.getOrder));
router.get('/:id/track', asyncHandler(c.trackOrder));
router.get('/:id/invoice', asyncHandler(c.getInvoice));
router.post('/:id/cancel', validateBody(cancelOrderSchema), asyncHandler(c.cancelOrder));
router.post('/:id/reorder', asyncHandler(c.reorder));

export default router;
