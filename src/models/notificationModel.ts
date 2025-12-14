import { type Document, model, Schema } from 'mongoose';

export type NotificationMedia = 'INTERNAL' | 'PUSH' | 'WHATSAPP';

export interface INotification extends Document {
  to: string;
  message: string;
  media: NotificationMedia;
  template: string;
  sent_date: Date;
  read_date?: Date;
  deleted_date?: Date;
}

const NotificationSchema = new Schema<INotification>({
  to: { type: String, required: true },
  message: { type: String, required: true },
  media: {
    type: String,
    enum: ['INTERNAL', 'PUSH', 'WHATSAPP'],
    required: true
  },
  template: { type: String, required: true },
  sent_date: { type: Date, required: true },
  read_date: { type: Date, required: false, default: null },
  deleted_date: { type: Date, required: false, default: null }
});

const NotificationModel = model<INotification>(
  'Notifications',
  NotificationSchema,
  'notifications'
);

export default NotificationModel;
