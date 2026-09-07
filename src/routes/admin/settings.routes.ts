import { Router } from 'express';
import * as c from '../../controllers/admin/adminSettings.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validateBody } from '../../middleware/validate.middleware';
import { updateSettingsSchema, serviceabilityCheckSchema } from '../../validators/admin.validator';

/**
 * Store settings administration (spec section 32, RULE 20).
 *
 * This screen is what makes the 20 business rules configurable without a code
 * change: COD ceiling and advance, GST mode, delivery pricing, the
 * quantity-discount resolution strategy, maintenance mode and the minimum
 * supported app version all live here. Writes go through `settings.service`,
 * which validates cross-field invariants and refreshes the in-memory cache the
 * pricing engine reads.
 */
const router = Router();

router.get('/', requirePermission('settings.read'), asyncHandler(c.getStoreSettings));
router.patch('/', requirePermission('settings.write'), validateBody(updateSettingsSchema), asyncHandler(c.updateStoreSettings));
router.post('/cache/refresh', requirePermission('settings.write'), asyncHandler(c.refreshSettingsCache));
router.post(
  '/serviceability',
  requirePermission('settings.read'),
  validateBody(serviceabilityCheckSchema),
  asyncHandler(c.checkServiceability),
);

export default router;
