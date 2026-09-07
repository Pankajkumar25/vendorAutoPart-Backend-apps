import { Router } from 'express';
import * as c from '../controllers/wallet.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.middleware';
import { objectId, objectIdParam } from '../validators/common.validator';
import { z } from 'zod';

const router = Router();

const topupSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  referenceId: z.string().optional(),
  referenceType: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

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

router.use(authenticate);

router.get('/', asyncHandler(c.getWallet));
router.get('/transactions', validateQuery(paginationQuery), asyncHandler(c.getWalletTransactions));
router.post('/topup', validateBody(topupSchema), asyncHandler(c.topupWallet));

export default router;