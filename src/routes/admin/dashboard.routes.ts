import { Router } from 'express';
import * as c from '../../controllers/admin/adminDashboard.controller';
import { asyncHandler } from '../../middleware/asyncHandler';
import { requirePermission } from '../../middleware/admin.middleware';
import { validateQuery } from '../../middleware/validate.middleware';
import { reportQuery } from '../../validators/admin.validator';

/**
 * Dashboard & reporting (spec sections 26, 30, 31). Read-only analytics behind a
 * single `reports.read` permission. Every figure is derived server-side from the
 * order and payment collections - the client never supplies totals. `exportSales`
 * streams CSV (or JSON with `?format=json`).
 */
const router = Router();

router.get('/', requirePermission('reports.read'), asyncHandler(c.dashboard));
router.get('/revenue', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.revenueSeries));
router.get('/top-products', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.topProducts));
router.get('/top-customers', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.topCustomers));
router.get('/category-sales', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.categorySales));
router.get('/discounts', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.discountReport));
router.get('/payments', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.paymentReport));
router.get('/inventory', requirePermission('reports.read'), asyncHandler(c.inventoryReport));
router.get('/tax', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.taxReport));
router.get('/export/sales', requirePermission('reports.read'), validateQuery(reportQuery), asyncHandler(c.exportSales));

export default router;
