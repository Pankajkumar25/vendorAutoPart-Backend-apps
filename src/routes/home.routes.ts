import { Router } from 'express';
import * as c from '../controllers/home.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { optionalAuth } from '../middleware/auth.middleware';

/**
 * Home screen aggregate (spec section 32). One call returns banners, featured
 * categories and product rails. `optionalAuth` lets a signed-in dealer's rails
 * carry their own prices while a signed-out visitor still gets the full screen.
 */
const router = Router();

router.get('/', optionalAuth, asyncHandler(c.getHome));

export default router;
