import { Router } from 'express';
import * as c from '../../controllers/admin/adminNotification.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validateBody } from '../../middleware/validate.middleware';
import { broadcastNotificationSchema } from '../../validators/admin.validator';

/**
 * Push / in-app notification broadcasts (spec section 31). An empty `userIds`
 * targets everyone; a populated list targets specific customers. Delivery and
 * fan-out are handled by `notification.service`.
 */
const router = Router();

router.post('/', requirePermission('notifications.write'), validateBody(broadcastNotificationSchema), asyncHandler(c.sendNotification));

export default router;
