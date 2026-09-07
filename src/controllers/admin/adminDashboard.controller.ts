import type { Request, Response } from 'express';
import {
  getDashboard,
  getRevenueSeries,
  getTopProducts,
  getTopCustomers,
  getCategorySales,
  getDiscountReport,
  getPaymentReport,
  getInventoryReport,
  getTaxReport,
  getSalesExportRows,
  toCsv,
  type DateRange,
} from '../../services/report.service';
import { ok } from '../../utils/apiResponse';

/**
 * Admin dashboard & reporting (spec sections 33, 35).
 *
 * All aggregation lives in `report.service`; this only parses the date range
 * and shapes the transport. The CSV export streams as a file download and is
 * reachable with `?access_token=` in the query string (the auth middleware
 * accepts a token there) so a browser link or a spreadsheet importer can fetch
 * it without setting an Authorization header.
 */

/** Pulls an optional `{ from, to }` window out of the query. */
function parseRange(query: Record<string, unknown>): DateRange {
  const range: DateRange = {};
  if (query.from) range.from = new Date(String(query.from));
  if (query.to) range.to = new Date(String(query.to));
  return range;
}

function parseLimit(query: Record<string, unknown>, fallback = 10): number {
  const n = Number(query.limit);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 100) : fallback;
}

export async function dashboard(_req: Request, res: Response): Promise<void> {
  ok(res, await getDashboard());
}

export async function revenueSeries(req: Request, res: Response): Promise<void> {
  const days = Number(req.query.days) || 30;
  ok(res, await getRevenueSeries(Math.min(Math.max(days, 1), 365)));
}

export async function topProducts(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  ok(res, await getTopProducts(parseLimit(query), parseRange(query)));
}

export async function topCustomers(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  ok(res, await getTopCustomers(parseLimit(query), parseRange(query)));
}

export async function categorySales(req: Request, res: Response): Promise<void> {
  ok(res, await getCategorySales(parseRange(req.query as Record<string, unknown>)));
}

export async function discountReport(req: Request, res: Response): Promise<void> {
  ok(res, await getDiscountReport(parseRange(req.query as Record<string, unknown>)));
}

export async function paymentReport(req: Request, res: Response): Promise<void> {
  ok(res, await getPaymentReport(parseRange(req.query as Record<string, unknown>)));
}

export async function inventoryReport(_req: Request, res: Response): Promise<void> {
  ok(res, await getInventoryReport());
}

export async function taxReport(req: Request, res: Response): Promise<void> {
  ok(res, await getTaxReport(parseRange(req.query as Record<string, unknown>)));
}

/**
 * Sales export (spec section 35). `format=csv` (the default) streams a download;
 * `format=json` returns the same rows as data for an in-app table.
 */
export async function exportSales(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const range = parseRange(query);
  const rows = await getSalesExportRows(range);

  if (query.format === 'json') {
    ok(res, rows);
    return;
  }

  const csv = toCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sales-${stamp}.csv"`);
  // BOM so Excel opens the UTF-8 file with the rupee sign intact.
  res.status(200).send(`﻿${csv}`);
}
