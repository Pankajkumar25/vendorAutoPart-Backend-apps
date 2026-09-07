import { Router } from 'express';
import * as c from '../../controllers/admin/adminPricing.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateParams } from '../../middleware/validate.middleware';
import {
  userParams,
  userProductParams,
  userPriceListQuery,
  setUserPriceSchema,
  bulkSetUserPricesSchema,
  applyPricingRuleSchema,
  copyPricingSchema,
} from '../../validators/admin.validator';

/**
 * Customer-specific pricing administration (spec sections 8-10) - the feature
 * the whole store exists for. Every route is addressed by a customer's own
 * `:userId`, so one dealer's negotiated prices are never reachable from another's
 * endpoint (RULES 18, 19). Read and write are separate permissions so prices can
 * be audited without being editable.
 */
const router = Router();

router.get(
  '/users/:userId',
  requirePermission('pricing.read'),
  validate({ params: userParams, query: userPriceListQuery }),
  asyncHandler(c.listUserPrices),
);
router.post(
  '/users/:userId/prices',
  requirePermission('pricing.write'),
  validate({ params: userParams, body: setUserPriceSchema }),
  asyncHandler(c.setUserPrice),
);
router.post(
  '/users/:userId/prices/bulk',
  requirePermission('pricing.write'),
  validate({ params: userParams, body: bulkSetUserPricesSchema }),
  asyncHandler(c.bulkSetUserPrices),
);
router.delete(
  '/users/:userId/prices/:productId',
  requirePermission('pricing.write'),
  validateParams(userProductParams),
  asyncHandler(c.deleteUserPrice),
);
router.post(
  '/users/:userId/apply-rule',
  requirePermission('pricing.write'),
  validate({ params: userParams, body: applyPricingRuleSchema }),
  asyncHandler(c.applyPricingRule),
);
router.post(
  '/users/:userId/copy',
  requirePermission('pricing.write'),
  validate({ params: userParams, body: copyPricingSchema }),
  asyncHandler(c.copyPricing),
);

export default router;
