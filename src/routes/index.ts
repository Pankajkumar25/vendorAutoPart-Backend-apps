import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.middleware';
import { maintenanceGate } from '../middleware/request.middleware';

import publicRoutes from './public.routes';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import addressRoutes from './address.routes';
import productRoutes from './product.routes';
import categoryRoutes from './category.routes';
import cartRoutes from './cart.routes';
import orderRoutes from './order.routes';
import paymentRoutes from './payment.routes';
import couponRoutes from './coupon.routes';
import searchRoutes from './search.routes';
import notificationRoutes from './notification.routes';
import homeRoutes from './home.routes';
import uploadRoutes from './upload.routes';
import walletRoutes from './wallet.routes';
import adminRoutes from './admin';

/**
 * The versioned API surface, mounted by `app.ts` under `env.API_PREFIX`.
 *
 * Two cross-cutting guards run first, in this exact order:
 *   1. `optionalAuth` populates `req.auth` when a valid token is present (and
 *      quietly ignores a bad one). It runs here so the maintenance gate can
 *      recognise an admin, and so `req.path` is already mount-relative.
 *   2. `maintenanceGate` blocks writes while maintenance mode is on (admins and
 *      reads exempt) and enforces the minimum app version. It relies on the
 *      auth context above, which is why order matters.
 *
 * Routers that require a real session still call `authenticate` themselves, so a
 * bad/absent token is rejected at the route rather than silently allowed here.
 *
 * NOTE: the payment webhook is deliberately NOT mounted here - it needs the raw
 * request body for signature verification and must bypass both guards, so
 * `app.ts` mounts it directly ahead of the JSON body parser.
 */
const router = Router();

router.use(optionalAuth);
router.use(maintenanceGate);

// Unauthenticated: health probe and public store settings (all maintenance-exempt).
router.use('/', publicRoutes);

// Customer-facing.
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/addresses', addressRoutes);
router.use('/products', productRoutes);
router.use('/categories', categoryRoutes);
router.use('/cart', cartRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/wallet', walletRoutes);
router.use('/coupons', couponRoutes);
router.use('/search', searchRoutes);
router.use('/notifications', notificationRoutes);
router.use('/home', homeRoutes);
router.use('/uploads', uploadRoutes);

// Admin (authenticate + requireAdmin applied inside).
router.use('/admin', adminRoutes);

export default router;
