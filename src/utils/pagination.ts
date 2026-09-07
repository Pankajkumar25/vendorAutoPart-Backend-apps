import type { PaginationMeta } from './apiResponse';

export interface PageQuery {
  page: number;
  limit: number;
  skip: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePagination(query: Record<string, unknown>, defaultLimit = DEFAULT_LIMIT): PageQuery {
  const rawPage = Number(query.page);
  const rawLimit = Number(query.limit);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit =
    Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : defaultLimit;
  return { page, limit, skip: (page - 1) * limit };
}

export function buildPaginationMeta(page: number, limit: number, total: number): PaginationMeta {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1 && totalPages > 0,
  };
}

/**
 * Translates a `sort=field:asc,other:desc` query string into a Mongoose sort
 * object, dropping any field not present in the caller's allow-list. Without
 * the allow-list a client could sort by an unindexed field and force a slow
 * collection scan.
 */
export function parseSort(
  sortParam: unknown,
  allowed: readonly string[],
  fallback: Record<string, 1 | -1>,
): Record<string, 1 | -1> {
  if (typeof sortParam !== 'string' || !sortParam.trim()) return fallback;
  const out: Record<string, 1 | -1> = {};
  for (const chunk of sortParam.split(',')) {
    const [field, dir] = chunk.split(':').map((s) => s.trim());
    if (!field || !allowed.includes(field)) continue;
    out[field] = dir === 'asc' ? 1 : -1;
  }
  return Object.keys(out).length ? out : fallback;
}
