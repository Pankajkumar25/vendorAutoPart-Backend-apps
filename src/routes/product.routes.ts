import { Router } from 'express';
import * as c from '../controllers/product.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { optionalAuth } from '../middleware/auth.middleware';
import { validate, validateParams, validateQuery } from '../middleware/validate.middleware';
import {
  productListQuery,
  productIdParams,
  slugParams,
  priceQuery,
} from '../validators/product.validator';

/**
 * Product catalogue, customer side (spec sections 13, 14).
 *
 * `optionalAuth` runs on every route: a signed-out visitor sees base prices, a
 * signed-in dealer sees their own negotiated prices, from the same handler. The
 * price is always resolved server-side from the caller's token id, never taken
 * from the request (RULES 14, 18).
 */
const router = Router();

router.use(optionalAuth);

router.get('/', validateQuery(productListQuery), asyncHandler(c.listProducts));
// Literal paths first so `/:id` cannot swallow them.
router.get('/filters', asyncHandler(c.getFilterOptions));
router.get('/slug/:slug', validateParams(slugParams), asyncHandler(c.getProduct));

router.get('/:id', validateParams(productIdParams), asyncHandler(c.getProduct));
router.get(
  '/:id/price',
  validate({ params: productIdParams, query: priceQuery }),
  asyncHandler(c.getProductPrice),
);
router.get('/:id/related', validateParams(productIdParams), asyncHandler(c.getRelatedProducts));

export default router;
