import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { User } from '../../models/user.model';
import { UserProductPrice } from '../../models/userProductPrice.model';
import { Order } from '../../models/order.model';
import { publicUser, revokeAllSessions } from '../../services/auth.service';
import { getUsersWithCustomPricing } from '../../services/userPricing.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { ROLES, USER_STATUS } from '../../config/constants';
import { ok, created, paginated } from '../../utils/apiResponse';
import { buildPaginationMeta, parsePagination } from '../../utils/pagination';
import { ApiError } from '../../utils/apiError';

/**
 * Customer & staff management (spec section 28).
 *
 * The identity acting here is always `req.auth` from a verified admin token -
 * never a role claimed in the body (RULE 17). Password hashing and the
 * tokenVersion bump that logs a disabled account out are handled by the User
 * model's hooks, so this layer only ever sets plain fields.
 */

const SORTS: Record<string, Record<string, 1 | -1>> = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name_asc: { name: 1 },
  name_desc: { name: -1 },
  last_login: { lastLoginAt: -1 },
};

export async function listUsers(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = {};
  if (typeof query.role === 'string') filter.role = query.role;
  if (typeof query.status === 'string') filter.status = query.status;
  if (typeof query.customerGroup === 'string') filter.customerGroup = query.customerGroup;
  if (typeof query.q === 'string' && query.q.trim()) {
    const rx = new RegExp(query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { mobile: rx }, { businessName: rx }];
  }

  // hasCustomPricing is a join onto the pricing collection, so it is resolved to
  // an id set before the main query rather than with a $lookup.
  if (query.hasCustomPricing !== undefined) {
    const priced = await UserProductPrice.distinct('userId');
    filter._id = { [query.hasCustomPricing === true ? '$in' : '$nin']: priced };
  }

  const sort = SORTS[String(query.sort ?? 'newest')] ?? SORTS.newest;

  const [rows, total] = await Promise.all([
    User.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    User.countDocuments(filter),
  ]);

  const pricedSet = await getUsersWithCustomPricing(rows.map((u) => String(u._id)));

  const items = rows.map((u) => ({
    id: String(u._id),
    name: u.name,
    email: u.email,
    mobile: u.mobile,
    role: u.role,
    status: u.status,
    permissions: u.permissions ?? [],
    businessName: u.businessName ?? null,
    gstNumber: u.gstNumber ?? null,
    customerGroup: u.customerGroup ?? null,
    hasCustomPricing: pricedSet.has(String(u._id)),
    lastLoginAt: u.lastLoginAt ?? null,
    createdAt: u.createdAt,
  }));

  paginated(res, items, buildPaginationMeta(page, limit, total));
}

export async function getUser(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  const [customPriceCount, orderCount] = await Promise.all([
    UserProductPrice.countDocuments({ userId: user._id }),
    Order.countDocuments({ userId: user._id }),
  ]);

  ok(res, {
    ...publicUser(user),
    notes: user.notes ?? null,
    customerGroup: user.customerGroup ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
    stats: { customPriceCount, orderCount },
  });
}

export async function createUser(req: Request, res: Response): Promise<void> {
  const actor = requireAuth(req);
  const body = req.body as Record<string, unknown>;

  // A non-admin must not carry permissions - they only mean anything on an admin.
  const permissions = body.role === ROLES.ADMIN ? (body.permissions as string[]) : [];

  const user = await User.create({
    name: body.name,
    email: body.email,
    mobile: body.mobile,
    password: body.password,
    role: body.role,
    status: body.status,
    permissions,
    businessName: body.businessName,
    gstNumber: body.gstNumber,
    customerGroup: body.customerGroup,
    notes: body.notes,
    createdBy: actor.userId,
  });

  created(res, publicUser(user), 'User created');
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  const body = req.body as Record<string, unknown>;
  const assignable = [
    'name',
    'email',
    'mobile',
    'role',
    'status',
    'businessName',
    'gstNumber',
    'customerGroup',
    'notes',
  ] as const;
  for (const field of assignable) {
    if (body[field] !== undefined) (user as unknown as Record<string, unknown>)[field] = body[field];
  }
  // Permissions only apply to admins; demoting to USER clears them.
  if (body.permissions !== undefined || body.role !== undefined) {
    user.permissions = user.role === ROLES.ADMIN ? ((body.permissions as never) ?? user.permissions) : [];
  }

  await user.save();
  ok(res, publicUser(user), 'User updated');
}

export async function setUserStatus(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  const body = req.body as { status: string; reason?: string };
  user.status = body.status as typeof user.status;
  if (body.reason) user.notes = body.reason;
  await user.save(); // status change bumps tokenVersion via pre-save

  // Disabling an account also kills any live refresh-token sessions immediately.
  if (body.status === USER_STATUS.DISABLED) {
    await revokeAllSessions(new Types.ObjectId(String(user._id)));
  }

  ok(res, publicUser(user), `User ${body.status === USER_STATUS.DISABLED ? 'disabled' : 'updated'}`);
}

export async function resetUserPassword(req: Request, res: Response): Promise<void> {
  const user = await User.findById(req.params.id).select('+password');
  if (!user) throw ApiError.notFound('User not found');

  user.password = (req.body as { newPassword: string }).newPassword; // hashed + tokenVersion bumped
  await user.save();
  await revokeAllSessions(new Types.ObjectId(String(user._id)));

  ok(res, { id: String(user._id) }, 'Password reset. The user must sign in again.');
}
