import { Router } from 'express';
import * as c from '../../controllers/admin/adminCategory.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateBody, validateParams } from '../../middleware/validate.middleware';
import { objectIdParam } from '../../validators/common.validator';
import { createCategorySchema, updateCategorySchema } from '../../validators/product.validator';

/**
 * Category administration (spec section 12). A category that still has products
 * or child categories cannot be deleted - the controller returns a 409 rather
 * than orphaning the catalogue.
 */
const router = Router();
const idParam = objectIdParam('id');

router.get('/', requirePermission('categories.read'), asyncHandler(c.listCategories));
router.post('/', requirePermission('categories.write'), validateBody(createCategorySchema), asyncHandler(c.createCategory));

router.get('/:id', requirePermission('categories.read'), validateParams(idParam), asyncHandler(c.getCategory));
router.patch(
  '/:id',
  requirePermission('categories.write'),
  validate({ params: idParam, body: updateCategorySchema }),
  asyncHandler(c.updateCategory),
);
router.delete('/:id', requirePermission('categories.write'), validateParams(idParam), asyncHandler(c.deleteCategory));

export default router;
