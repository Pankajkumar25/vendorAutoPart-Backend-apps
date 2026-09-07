import { Router } from 'express';
import * as c from '../../controllers/admin/adminProduct.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateBody, validateParams } from '../../middleware/validate.middleware';
import { objectIdParam } from '../../validators/common.validator';
import {
  createProductSchema,
  updateProductSchema,
  stockAdjustSchema,
  bulkProductStatusSchema,
} from '../../validators/product.validator';

/**
 * Product & catalogue administration (spec section 29).
 *
 * The list query is intentionally not schema-validated: the admin grid carries
 * status/low-stock/sort filters the customer catalogue schema would strip, and
 * the controller parses them defensively behind an admin permission.
 */
const router = Router();
const idParam = objectIdParam('id');

router.get('/', requirePermission('products.read'), asyncHandler(c.listProducts));
router.post('/', requirePermission('products.write'), validateBody(createProductSchema), asyncHandler(c.createProduct));
router.post(
  '/bulk/status',
  requirePermission('products.write'),
  validateBody(bulkProductStatusSchema),
  asyncHandler(c.bulkSetStatus),
);

router.get('/:id', requirePermission('products.read'), validateParams(idParam), asyncHandler(c.getProduct));
router.patch(
  '/:id',
  requirePermission('products.write'),
  validate({ params: idParam, body: updateProductSchema }),
  asyncHandler(c.updateProduct),
);
router.post(
  '/:id/stock',
  requirePermission('products.write'),
  validate({ params: idParam, body: stockAdjustSchema }),
  asyncHandler(c.adjustStock),
);
router.delete('/:id', requirePermission('products.write'), validateParams(idParam), asyncHandler(c.deleteProduct));

export default router;
