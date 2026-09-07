import { Router } from 'express';
import { authenticate } from '../../middleware/auth.middleware';
import { requireAdmin } from '../../middleware/admin.middleware';

import userRoutes from './user.routes';
import productRoutes from './product.routes';
import categoryRoutes from './category.routes';
import orderRoutes from './order.routes';
import pricingRoutes from './pricing.routes';
import quantityDiscountRoutes from './quantityDiscount.routes';
import couponRoutes from './coupon.routes';
import settingsRoutes from './settings.routes';
import dashboardRoutes from './dashboard.routes';
import notificationRoutes from './notification.routes';
import walletRoutes from './wallet.routes';

/**
 * Admin API surface (spec sections 24-34, RULE 17).
 *
 * Authentication and the admin-role gate are applied ONCE here, so every
 * sub-router below is unreachable without a valid admin session - the
 * per-action `requirePermission(...)` guards then narrow within that. Doing the
 * role check in one place means a new admin router can never be mounted while
 * accidentally forgetting to protect it.
 */
const router = Router();

router.use(authenticate, requireAdmin);

router.use('/users', userRoutes);
router.use('/products', productRoutes);
router.use('/categories', categoryRoutes);
router.use('/orders', orderRoutes);
router.use('/pricing', pricingRoutes);
router.use('/quantity-discounts', quantityDiscountRoutes);
router.use('/coupons', couponRoutes);
router.use('/settings', settingsRoutes);
router.use('/reports', dashboardRoutes);
router.use('/notifications', notificationRoutes);
router.use('/wallet', walletRoutes);

export default router;
