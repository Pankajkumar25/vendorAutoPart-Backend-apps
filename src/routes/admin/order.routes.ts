import { Router } from 'express';
import * as c from '../../controllers/admin/adminOrder.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validate, validateParams, validateQuery } from '../../middleware/validate.middleware';
import { objectIdParam } from '../../validators/common.validator';
import {
  adminOrderListQuery,
  updateOrderStatusSchema,
  recordCodCollectionSchema,
  refundSchema,
} from '../../validators/admin.validator';

/**
 * Order administration (spec sections 24, 25, 27). Every money-moving action
 * delegates to `order.service`, which recomputes and caps figures - status
 * transitions are checked against the allowed flow, COD collection cannot exceed
 * the balance, and refunds cannot exceed the captured amount (RULES 14-16).
 */
const router = Router();
const idParam = objectIdParam('id');

router.get('/', requirePermission('orders.read'), validateQuery(adminOrderListQuery), asyncHandler(c.listOrders));
router.get('/:id', requirePermission('orders.read'), validateParams(idParam), asyncHandler(c.getOrder));

router.post(
  '/:id/status',
  requirePermission('orders.write'),
  validate({ params: idParam, body: updateOrderStatusSchema }),
  asyncHandler(c.updateStatus),
);
router.post(
  '/:id/cod-collection',
  requirePermission('orders.write'),
  validate({ params: idParam, body: recordCodCollectionSchema }),
  asyncHandler(c.recordCodCollection),
);
router.post(
  '/:id/refund',
  requirePermission('orders.write'),
  validate({ params: idParam, body: refundSchema }),
  asyncHandler(c.refund),
);

export default router;
