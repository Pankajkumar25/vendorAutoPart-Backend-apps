import { Router } from 'express';
import * as c from '../controllers/search.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate, optionalAuth } from '../middleware/auth.middleware';
import { validateQuery } from '../middleware/validate.middleware';
import { searchLimiter } from '../middleware/rateLimit.middleware';
import { searchQuery, suggestQuery } from '../validators/product.validator';

/**
 * Search & discovery (spec section 14). Browsing is open (with `optionalAuth`
 * so a dealer's own prices decorate the results); the personalised
 * recently-viewed list requires a token. The search endpoints are rate-limited
 * because autocomplete fires on every keystroke.
 */
const router = Router();

router.use(optionalAuth);

router.get('/', searchLimiter, validateQuery(searchQuery), asyncHandler(c.searchProducts));
router.get('/suggest', searchLimiter, validateQuery(suggestQuery), asyncHandler(c.suggest));
router.get('/landing', asyncHandler(c.getSearchLanding));

router.get('/recent', authenticate, asyncHandler(c.getRecentlyViewed));
router.delete('/recent', authenticate, asyncHandler(c.clearRecent));

export default router;
