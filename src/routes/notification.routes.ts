import { Router } from 'express';
import * as c from '../controllers/notification.controller';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticate } from '../middleware/auth.middleware';
import { validateParams, validateQuery } from '../middleware/validate.middleware';
import { paginationQuery, objectIdParam } from '../validators/common.validator';

/**
 * In-app notifications (spec section 31). Every row is per-customer, so all
 * routes are private and scoped to the caller's token id.
 */
const router = Router();

router.use(authenticate);

router.get('/', validateQuery(paginationQuery), asyncHandler(c.listNotifications));
router.get('/unread-count', asyncHandler(c.getUnreadCount));
router.post('/read-all', asyncHandler(c.markAllRead));
router.post('/:id/read', validateParams(objectIdParam('id')), asyncHandler(c.markRead));
router.delete('/:id', validateParams(objectIdParam('id')), asyncHandler(c.deleteNotification));

export default router;
