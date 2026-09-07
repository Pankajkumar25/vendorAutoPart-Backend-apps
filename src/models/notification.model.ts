import mongoose, { Schema, type Document, type Model, type Types } from 'mongoose';
import { NOTIFICATION_TYPE, type NotificationType } from '../config/constants';

export interface INotification extends Document {
  _id: Types.ObjectId;
  /** `null` = broadcast to every customer. */
  userId?: Types.ObjectId | null;
  type: NotificationType;
  title: string;
  body: string;
  image?: string;
  /** Deep-link target the app routes to on tap, e.g. `/order/123`. */
  route?: string;
  data?: Record<string, unknown>;
  isRead: boolean;
  readAt?: Date | null;
  /** Push-delivery bookkeeping - see notification.service for the adapter. */
  pushSentAt?: Date | null;
  pushError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    type: { type: String, enum: Object.values(NOTIFICATION_TYPE), default: NOTIFICATION_TYPE.GENERAL },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    image: { type: String, trim: true },
    route: { type: String, trim: true, maxlength: 300 },
    data: { type: Schema.Types.Mixed },
    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    pushSentAt: { type: Date, default: null },
    pushError: { type: String, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

export type INotificationModel = Model<INotification>;

export const Notification =
  (mongoose.models.Notification as INotificationModel) ??
  mongoose.model<INotification, INotificationModel>('Notification', notificationSchema);
