import { Router } from 'express';
import * as c from '../../controllers/wallet.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.middleware';
import { objectId, objectIdParam } from '../../validators/common.validator';
import { z } from 'zod';

const router = Router();
const idParam = objectIdParam('userId');

const adjustSchema = z.object({
  userId: objectId,
  amount: z.number().refine((val) => val !== 0, 'Amount cannot be zero'),
  description: z.string().min(1, 'Description is required'),
  metadata: z.record(z.unknown()).optional(),
});

const paginationQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

router.use(requirePermission('users.write'));

router.get('/:userId', validateParams(idParam), asyncHandler(c.adminGetUserWallet));
router.post('/adjust', validateBody(adjustSchema), asyncHandler(c.adminAdjustWallet));

export default router;