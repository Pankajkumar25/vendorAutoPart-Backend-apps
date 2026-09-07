import { Router } from 'express';
import * as c from '../controllers/settings.controller';
import { asyncHandler } from '../middleware/asyncHandler';

/**
 * Public app configuration and health (spec section 32).
 *
 * These carry no secrets - `getPublicSettings` in the service strips anything
 * sensitive. They are also the routes the maintenance gate lets through, so the
 * app can always read config and the load balancer can always probe `/health`
 * even while the store is in maintenance mode.
 */
const router = Router();

router.get('/health', asyncHandler(c.healthCheck));
router.get('/settings', asyncHandler(c.getPublicSettingsController));
router.get('/settings/app-config', asyncHandler(c.getAppConfig));

export default router;
