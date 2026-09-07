import { Router } from 'express';
import * as c from '../controllers/cart.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validate, validateBody, validateParams, validateQuery } from '../middleware/validate.middleware';
import {
  addToCartSchema,
  updateCartItemSchema,
  cartItemParams,
  cartQuery,
  applyCouponSchema,
} from '../validators/cart.validator';

/**
 * Cart (spec section 15). Every route is private to the signed-in customer and
 * every mutation returns the whole re-priced cart, so the client never has to
 * compute a total itself - the pricing engine is the only source of prices
 * (RULES 14, 15).
 */
const router = Router();

router.use(authenticate);

router.get('/', validateQuery(cartQuery), asyncHandler(c.getCart));
router.get('/count', asyncHandler(c.getCount));
router.delete('/', asyncHandler(c.clearCart));

router.post('/items', validateBody(addToCartSchema), asyncHandler(c.addItem));
router.patch(
  '/items/:productId',
  validate({ params: cartItemParams, body: updateCartItemSchema }),
  asyncHandler(c.updateItem),
);
router.delete('/items/:productId', validateParams(cartItemParams), asyncHandler(c.removeItem));
router.post('/items/:productId/save', validateParams(cartItemParams), asyncHandler(c.saveForLater));
router.post('/items/:productId/move', validateParams(cartItemParams), asyncHandler(c.moveToCart));

router.post('/coupon', validateBody(applyCouponSchema), asyncHandler(c.applyCoupon));
router.delete('/coupon', asyncHandler(c.removeCoupon));
router.post('/coupon/preview', validateBody(applyCouponSchema), asyncHandler(c.previewCoupon));

router.post('/reconcile', asyncHandler(c.reconcile));

export default router;
