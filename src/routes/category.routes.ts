import { Router } from 'express';
import * as c from '../controllers/category.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { optionalAuth } from '../middleware/auth.middleware';
import { validateParams, validateQuery } from '../middleware/validate.middleware';
import { categoryListQuery, slugParams } from '../validators/product.validator';
import { objectIdParam } from '../validators/common.validator';

/**
 * Category tree, customer side (spec section 12). Public browsing data;
 * `optionalAuth` is present only so the same token context flows through if a
 * signed-in dealer is navigating.
 */
const router = Router();

router.use(optionalAuth);

router.get('/', validateQuery(categoryListQuery), asyncHandler(c.listCategories));
router.get('/featured', asyncHandler(c.getFeaturedCategories));
router.get('/slug/:slug', validateParams(slugParams), asyncHandler(c.getCategory));
router.get('/:id', validateParams(objectIdParam('id')), asyncHandler(c.getCategory));

export default router;
