import type { Request, Response } from 'express';
import { Notification } from '../models/notification.model';
import * as notificationService from '../services/notification.service';
import { requireAuth } from '../middleware/auth.middleware';
import { noContent, ok, paginated } from '../utils/apiResponse';
import { ApiError } from '../utils/apiError';
import { buildPaginationMeta, parsePagination } from '../utils/pagination';

/**
 * In-app notifications, customer side (spec section 31).
 *
 * Every query is scoped to `auth.userId` from the verified token, so a customer
 * can only ever see, read or delete their own notifications. The `broadcast`
 * path in the service fans a global message out into one row per customer, so
 * there is no shared row a customer could accidentally mark read for everyone.
 */

function shape(n: {
  _id: unknown;
  type: string;
  title: string;
  body: string;
  image?: string;
  route?: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  readAt?: Date | null;
  createdAt: Date;
}) {
  return {
    id: String(n._id),
    type: n.type,
    title: n.title,
    body: n.body,
    image: n.image ?? null,
    route: n.route ?? null,
    data: n.data ?? null,
    isRead: n.isRead,
    readAt: n.readAt ?? null,
    createdAt: n.createdAt,
  };
}

/**
 * The notification centre list. Supports `?unread=true` to show only the
 * unread ones, and always returns the current unread count in the meta so the
 * app's bell badge can be updated from the same round-trip.
 */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const query = req.query as Record<string, unknown>;
  const { page, limit, skip } = parsePagination(query);

  const filter: Record<string, unknown> = { userId: auth.userId };
  if (query.unread === true || query.unread === 'true') filter.isRead = false;
  if (typeof query.type === 'string' && query.type) filter.type = query.type;

  const [rows, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    notificationService.unreadCount(auth.userId),
  ]);

  paginated(res, rows.map(shape), buildPaginationMeta(page, limit, total), undefined, {
    unreadCount: unread,
  });
}

/** Just the badge number, for a cheap poll on app foreground. */
export async function getUnreadCount(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  ok(res, { unreadCount: await notificationService.unreadCount(auth.userId) });
}

export async function markRead(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const found = await notificationService.markAsRead(auth.userId, req.params.id);
  if (!found) throw ApiError.notFound('Notification not found');
  ok(res, { unreadCount: await notificationService.unreadCount(auth.userId) }, 'Marked as read');
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const updated = await notificationService.markAllAsRead(auth.userId);
  ok(res, { updated, unreadCount: 0 }, updated ? 'All notifications marked as read' : 'Nothing to mark');
}

/** Lets a customer clear a notification from their own centre. */
export async function deleteNotification(req: Request, res: Response): Promise<void> {
  const auth = requireAuth(req);
  const result = await Notification.deleteOne({ _id: req.params.id, userId: auth.userId });
  if (!result.deletedCount) throw ApiError.notFound('Notification not found');
  noContent(res);
}
