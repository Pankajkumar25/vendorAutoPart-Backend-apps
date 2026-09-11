import { Types } from 'mongoose';
import { Notification, type INotification } from '../models/notification.model';
import { User } from '../models/user.model';
import { NOTIFICATION_TYPE, ORDER_STATUS, type NotificationType, type OrderStatus } from '../config/constants';
import { logger } from '../config/logger';
import { formatINR } from '../utils/money';

/**
 * Notifications (spec section 31).
 *
 * Every notification is persisted first so the in-app bell is authoritative and
 * works offline-first. Push delivery is a best-effort layer on top: if the push
 * transport fails the record still exists and the customer sees it next time
 * they open the app.
 *
 * `sendPush` is deliberately a thin seam. Dropping in Expo Push or FCM means
 * implementing one function; nothing else in the codebase changes.
 */

export interface CreateNotificationInput {
  userId?: string | Types.ObjectId | null;
  type?: NotificationType;
  title: string;
  body: string;
  route?: string;
  image?: string;
  data?: Record<string, unknown>;
  /** Attempt push delivery in addition to storing the record. */
  push?: boolean;
}

export async function createNotification(input: CreateNotificationInput): Promise<INotification> {
  const notification = await Notification.create({
    userId: input.userId ?? null,
    type: input.type ?? NOTIFICATION_TYPE.GENERAL,
    title: input.title,
    body: input.body,
    route: input.route,
    image: input.image,
    data: input.data,
  });

  if (input.push !== false && input.userId) {
    // Fire and forget: a push failure must never fail the business operation
    // that triggered it (e.g. do not fail an order because FCM is down).
    void deliverPush(notification).catch((err) => logger.warn('[notify] push failed', err));
  }

  return notification;
}

/** Broadcast to every active customer. Used for new coupons/products/offers. */
export async function broadcast(
  input: Omit<CreateNotificationInput, 'userId'> & { onlyActive?: boolean },
): Promise<number> {
  const users = await User.find({
    role: 'USER',
    ...(input.onlyActive === false ? {} : { status: 'ACTIVE' }),
  })
    .select('_id')
    .lean();

  if (!users.length) return 0;

  await Notification.insertMany(
    users.map((u) => ({
      userId: u._id,
      type: input.type ?? NOTIFICATION_TYPE.GENERAL,
      title: input.title,
      body: input.body,
      route: input.route,
      image: input.image,
      data: input.data,
    })),
  );

  logger.info(`[notify] broadcast "${input.title}" to ${users.length} users`);
  return users.length;
}

/** Notify every admin user. Used for new orders, low-stock alerts, etc. */
export async function notifyAdmins(
  input: Omit<CreateNotificationInput, 'userId'>,
): Promise<number> {
  const admins = await User.find({ role: 'ADMIN', status: 'ACTIVE' })
    .select('_id')
    .lean();

  if (!admins.length) return 0;

  await Notification.insertMany(
    admins.map((a) => ({
      userId: a._id,
      type: input.type ?? NOTIFICATION_TYPE.GENERAL,
      title: input.title,
      body: input.body,
      route: input.route,
      image: input.image,
      data: input.data,
    })),
  );

  logger.info(`[notify] admin notification "${input.title}" to ${admins.length} admins`);
  return admins.length;
}

/**
 * Push transport seam. Currently logs only.
 *
 * To wire up Expo: POST the tokens on the user record to
 * https://exp.host/--/api/v2/push/send with { to, title, body, data }.
 */
async function deliverPush(notification: INotification): Promise<void> {
  if (!notification.userId) return;
  const user = await User.findById(notification.userId).select('pushTokens').lean();
  const tokens = user?.pushTokens ?? [];
  if (!tokens.length) return;

  logger.debug(`[notify] would push to ${tokens.length} device(s): ${notification.title}`);
  await Notification.updateOne({ _id: notification._id }, { $set: { pushSentAt: new Date() } });
}

// ---------------------------------------------------------------------------
// Order lifecycle notifications
// ---------------------------------------------------------------------------

/** Customer-facing copy for each order status (spec section 31). */
const STATUS_COPY: Partial<Record<OrderStatus, { type: NotificationType; title: string; body: (n: string) => string }>> = {
  [ORDER_STATUS.CONFIRMED]: {
    type: NOTIFICATION_TYPE.ORDER_CONFIRMED,
    title: 'Order confirmed',
    body: (n) => `Your order ${n} is confirmed and will be processed shortly.`,
  },
  [ORDER_STATUS.PROCESSING]: {
    type: NOTIFICATION_TYPE.ORDER_PROCESSING,
    title: 'Order is being prepared',
    body: (n) => `We have started preparing order ${n}.`,
  },
  [ORDER_STATUS.PACKED]: {
    type: NOTIFICATION_TYPE.ORDER_PACKED,
    title: 'Order packed',
    body: (n) => `Order ${n} has been packed and is ready to ship.`,
  },
  [ORDER_STATUS.SHIPPED]: {
    type: NOTIFICATION_TYPE.ORDER_SHIPPED,
    title: 'Order shipped',
    body: (n) => `Order ${n} is on its way.`,
  },
  [ORDER_STATUS.OUT_FOR_DELIVERY]: {
    type: NOTIFICATION_TYPE.ORDER_OUT_FOR_DELIVERY,
    title: 'Out for delivery',
    body: (n) => `Order ${n} is out for delivery and will reach you today.`,
  },
  [ORDER_STATUS.DELIVERED]: {
    type: NOTIFICATION_TYPE.ORDER_DELIVERED,
    title: 'Order delivered',
    body: (n) => `Order ${n} has been delivered. Thank you for your business.`,
  },
  [ORDER_STATUS.CANCELLED]: {
    type: NOTIFICATION_TYPE.ORDER_CANCELLED,
    title: 'Order cancelled',
    body: (n) => `Order ${n} has been cancelled.`,
  },
  [ORDER_STATUS.RETURNED]: {
    type: NOTIFICATION_TYPE.ORDER_RETURNED,
    title: 'Order returned',
    body: (n) => `A return has been recorded for order ${n}.`,
  },
};

export async function notifyOrderStatus(params: {
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  status: OrderStatus;
}): Promise<void> {
  const copy = STATUS_COPY[params.status];
  if (!copy) return;
  await createNotification({
    userId: params.userId,
    type: copy.type,
    title: copy.title,
    body: copy.body(params.orderNumber),
    route: `/order/${params.orderId}`,
    data: { orderId: String(params.orderId), orderNumber: params.orderNumber, status: params.status },
  });
}

export async function notifyOrderPlaced(params: {
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  total: number;
}): Promise<void> {
  // Notify the customer
  await createNotification({
    userId: params.userId,
    type: NOTIFICATION_TYPE.ORDER_PLACED,
    title: 'Order placed',
    body: `We have received order ${params.orderNumber} for ${formatINR(params.total)}.`,
    route: `/order/${params.orderId}`,
    data: { orderId: String(params.orderId), orderNumber: params.orderNumber },
  });

  // Notify all admin users about the new order
  await notifyAdmins({
    type: NOTIFICATION_TYPE.ORDER_PLACED,
    title: 'New order received',
    body: `Order ${params.orderNumber} for ${formatINR(params.total)} has been placed.`,
    route: `/admin/order/${params.orderId}`,
    data: { orderId: String(params.orderId), orderNumber: params.orderNumber, total: params.total },
  });
}

export async function notifyPaymentSuccess(params: {
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  amount: number;
  isAdvance: boolean;
  remainingCod?: number;
}): Promise<void> {
  await createNotification({
    userId: params.userId,
    type: params.isAdvance ? NOTIFICATION_TYPE.ADVANCE_PAYMENT_SUCCESS : NOTIFICATION_TYPE.PAYMENT_SUCCESS,
    title: params.isAdvance ? 'Advance payment received' : 'Payment successful',
    body: params.isAdvance
      ? `We received your advance of ${formatINR(params.amount)} for order ${params.orderNumber}. ` +
        `${formatINR(params.remainingCod ?? 0)} is payable on delivery.`
      : `Payment of ${formatINR(params.amount)} for order ${params.orderNumber} was successful.`,
    route: `/order/${params.orderId}`,
    data: { orderId: String(params.orderId), orderNumber: params.orderNumber },
  });
}

export async function notifyPaymentFailed(params: {
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  orderNumber: string;
  reason?: string;
}): Promise<void> {
  await createNotification({
    userId: params.userId,
    type: NOTIFICATION_TYPE.PAYMENT_FAILED,
    title: 'Payment failed',
    body:
      params.reason ??
      `We could not process the payment for order ${params.orderNumber}. Please try again.`,
    route: `/order/${params.orderId}`,
    data: { orderId: String(params.orderId), orderNumber: params.orderNumber },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function markAsRead(userId: Types.ObjectId, notificationId: string): Promise<boolean> {
  const res = await Notification.updateOne(
    { _id: notificationId, userId },
    { $set: { isRead: true, readAt: new Date() } },
  );
  return res.matchedCount > 0;
}

export async function markAllAsRead(userId: Types.ObjectId): Promise<number> {
  const res = await Notification.updateMany(
    { userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
  return res.modifiedCount;
}

export async function unreadCount(userId: Types.ObjectId): Promise<number> {
  return Notification.countDocuments({ userId, isRead: false });
}
