import type { Request, Response } from 'express';
import { Notification } from '../../models/notification.model';
import { broadcast } from '../../services/notification.service';
import { requireAuth } from '../../middleware/auth.middleware';
import { ok } from '../../utils/apiResponse';
import { NOTIFICATION_TYPE } from '../../config/constants';

/**
 * Admin push / in-app notifications (spec section 31).
 *
 * Two modes from one endpoint: with an explicit `userIds` list the message goes
 * to exactly those customers; with the list omitted (or empty) it fans out to
 * every active customer via the notification service. Either way each customer
 * gets their own stored row, so read-state is per person.
 */

export async function sendNotification(req: Request, res: Response): Promise<void> {
  // Actor is resolved to assert an authenticated admin identity even though the
  // message body is not attributed to them in the customer-facing payload.
  requireAuth(req);

  const body = req.body as {
    title: string;
    body: string;
    route?: string;
    image?: string;
    userIds?: string[];
  };
  const image = body.image && body.image.trim() ? body.image : undefined;

  if (body.userIds && body.userIds.length) {
    const rows = body.userIds.map((userId) => ({
      userId,
      type: NOTIFICATION_TYPE.GENERAL,
      title: body.title,
      body: body.body,
      route: body.route,
      image,
    }));
    await Notification.insertMany(rows);
    ok(res, { delivered: rows.length, mode: 'targeted' }, `Sent to ${rows.length} customer(s)`);
    return;
  }

  const count = await broadcast({
    type: NOTIFICATION_TYPE.GENERAL,
    title: body.title,
    body: body.body,
    route: body.route,
    image,
  });
  ok(res, { delivered: count, mode: 'broadcast' }, `Broadcast to ${count} customer(s)`);
}
