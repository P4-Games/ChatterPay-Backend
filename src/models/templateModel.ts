import { model, Schema, Document } from 'mongoose';

export enum LanguageEnum {
  en = 'en',
  es = 'es',
  pt = 'pt'
}

export enum NotificationEnum {
  transfer = 'transfer',
  swap = 'swap',
  mint = 'mint',
  outgoing_transfer = 'outgoing_transfer',
  wallet_creation = 'wallet_creation',
  user_balance_not_enough = 'user_balance_not_enough',
  no_valid_blockchain_conditions = 'no_valid_blockchain_conditions',
  internal_error = 'internal_error',
  concurrent_operation = 'concurrent_operation',
  daily_limit_reached = 'daily_limit_reached',
  amount_outside_limits = 'amount_outside_limits'
}

export interface LocalizedContentType {
  en: string;
  es: string;
  pt: string;
}

export interface NotificationTemplateType {
  title: LocalizedContentType;
  message: LocalizedContentType;
}

export interface NotificationTemplatesTypes {
  // @ts-expect-error 'mark as error'
  [key in NotificationEnum]: NotificationTemplateType;
}

export interface ITemplateSchema extends Document {
  notifications: {
    [key in NotificationEnum]: NotificationTemplateType;
  };
}

const localizedContentSchema = new Schema<LocalizedContentType>({
  en: { type: String, required: true },
  es: { type: String, required: true },
  pt: { type: String, required: true }
});

const notificationSchema = new Schema<NotificationTemplateType>({
  title: { type: localizedContentSchema, required: true },
  message: { type: localizedContentSchema, required: true }
});

const templateSchema = new Schema<ITemplateSchema>({
  notifications: {
    transfer: { type: notificationSchema, required: true },
    swap: { type: notificationSchema, required: true },
    mint: { type: notificationSchema, required: true },
    outgoing_transfer: { type: notificationSchema, required: true },
    wallet_creation: { type: notificationSchema, required: true },
    user_balance_not_enough: { type: notificationSchema, required: true },
    no_valid_blockchain_conditions: { type: notificationSchema, required: true },
    concurrent_operation: { type: notificationSchema, required: true },
    internal_error: { type: notificationSchema, required: true },
    daily_limit_reached: { type: notificationSchema, required: true },
    amount_outside_limits: { type: notificationSchema, required: true }
  }
});

export const TemplateType = model<ITemplateSchema>('Template', templateSchema, 'templates');
