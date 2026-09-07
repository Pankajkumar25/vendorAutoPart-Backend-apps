import { Router } from 'express';
import { z } from 'zod';
import * as c from '../../controllers/admin/adminQuantityDiscount.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateBody, validateParams, validateQuery } from '../../middleware/validate.middleware';
import { objectId, objectIdParam } from '../../validators/common.validator';
import {
  quantityRuleListQuery,
  createQuantityRuleSchema,
  updateQuantityRuleSchema,
  createUserQuantityRuleSchema,
  setQuantityLadderSchema,
} from '../../validators/admin.validator';

/**
 * Quantity-discount ladder administration (spec sections 11-13, 34, RULE 5).
 *
 * The tiers are pure data - the admin defines `{ minimumQuantity,
 * discountPercentage }` rows and edits them at will (RULE 20). RULE 7 (only the
 * single highest qualifying tier ever applies) is enforced by the resolver at
 * checkout, not here. Global/product/category ladders and per-customer ladders
 * share this router; the per-customer routes are addressed by `:userId` so one
 * dealer's ladder is never reachable from another's.
 */
const router = Router();
const idParam = objectIdParam('id');
const userParam = objectIdParam('userId');
// Per-customer rule mutations are keyed by both the owning customer and the rule.
const userRuleParams = z.object({ userId: objectId, id: objectId });

// Global / product / category ladders. A `?userId=` on the list turns it into a
// per-customer ladder listing (handled inside the controller).
router.get('/', requirePermission('discounts.read'), validateQuery(quantityRuleListQuery), asyncHandler(c.listRules));
router.post('/', requirePermission('discounts.write'), validateBody(createQuantityRuleSchema), asyncHandler(c.createRule));

// Whole-ladder replace for one scope in a single call. Declared before '/:id'
// so the literal path is never captured by the id matcher.
router.post('/ladder', requirePermission('discounts.write'), validateBody(setQuantityLadderSchema), asyncHandler(c.setLadder));

// Per-customer ladders (literal '/users' segment, also before '/:id').
router.post(
  '/users/:userId',
  requirePermission('discounts.write'),
  validate({ params: userParam, body: createUserQuantityRuleSchema }),
  asyncHandler(c.createUserRule),
);
router.patch(
  '/users/:userId/:id',
  requirePermission('discounts.write'),
  validate({ params: userRuleParams, body: updateQuantityRuleSchema }),
  asyncHandler(c.updateUserRule),
);
router.delete(
  '/users/:userId/:id',
  requirePermission('discounts.write'),
  validateParams(userRuleParams),
  asyncHandler(c.deleteUserRule),
);

// Global rule mutations by id.
router.patch(
  '/:id',
  requirePermission('discounts.write'),
  validate({ params: idParam, body: updateQuantityRuleSchema }),
  asyncHandler(c.updateRule),
);
router.delete('/:id', requirePermission('discounts.write'), validateParams(idParam), asyncHandler(c.deleteRule));

export default router;
