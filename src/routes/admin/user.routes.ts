import { Router } from 'express';
import * as c from '../../controllers/admin/adminUser.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateBody, validateParams, validateQuery } from '../../middleware/validate.middleware';
import { objectIdParam } from '../../validators/common.validator';
import {
  adminUserListQuery,
  adminCreateUserSchema,
  adminUpdateUserSchema,
  adminSetUserStatusSchema,
  adminResetUserPasswordSchema,
} from '../../validators/admin.validator';

/**
 * Customer & staff administration (spec section 28, RULE 17). Read and write are
 * separate permissions so an auditor can list users without being able to edit
 * them.
 */
const router = Router();
const idParam = objectIdParam('id');

router.get('/', requirePermission('users.read'), validateQuery(adminUserListQuery), asyncHandler(c.listUsers));
router.post('/', requirePermission('users.write'), validateBody(adminCreateUserSchema), asyncHandler(c.createUser));

router.get('/:id', requirePermission('users.read'), validateParams(idParam), asyncHandler(c.getUser));
router.patch(
  '/:id',
  requirePermission('users.write'),
  validate({ params: idParam, body: adminUpdateUserSchema }),
  asyncHandler(c.updateUser),
);
router.post(
  '/:id/status',
  requirePermission('users.write'),
  validate({ params: idParam, body: adminSetUserStatusSchema }),
  asyncHandler(c.setUserStatus),
);
router.post(
  '/:id/reset-password',
  requirePermission('users.write'),
  validate({ params: idParam, body: adminResetUserPasswordSchema }),
  asyncHandler(c.resetUserPassword),
);

export default router;
