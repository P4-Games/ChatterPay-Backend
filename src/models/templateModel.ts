import { type Document, model, Schema } from 'mongoose';

export enum NotificationEnum {
  incoming_transfer = 'incoming_transfer',
  incoming_transfer_w_note = 'incoming_transfer_w_note',
  incoming_transfer_external = 'incoming_transfer_external',
  swap = 'swap',
  mint = 'mint',
  outgoing_transfer = 'outgoing_transfer',
  wallet_creation = 'wallet_creation',
  wallet_already_exists = 'wallet_already_exists',
  user_balance_not_enough = 'user_balance_not_enough',
  no_valid_blockchain_conditions = 'no_valid_blockchain_conditions',
  internal_error = 'internal_error',
  concurrent_operation = 'concurrent_operation',
  daily_limit_reached = 'daily_limit_reached',
  amount_outside_limits = 'amount_outside_limits',
  aave_supply_created = 'aave_supply_created',
  aave_supply_info = 'aave_supply_info',
  aave_supply_info_no_data = 'aave_supply_info_no_data',
  aave_supply_modified = 'aave_supply_modified',
  chatterpoints_operation = 'chatterpoints_operation',
  cross_chain_disabled = 'cross_chain_disabled',
  polymarket_account_created = 'polymarket_account_created',
  polymarket_order_placed = 'polymarket_order_placed',
  polymarket_order_cancelled = 'polymarket_order_cancelled',
  polymarket_order_failed = 'polymarket_order_failed',
  polymarket_terms_not_accepted = 'polymarket_terms_not_accepted',
  polymarket_account_not_found = 'polymarket_account_not_found',
  polymarket_bridge_initiated = 'polymarket_bridge_initiated',
  polymarket_disabled = 'polymarket_disabled'
}

export interface LocalizedContentType {
  en: string;
  es: string;
  pt: string;
}

export interface NotificationUtilityConfigType {
  enabled: boolean;
  template_key: string;
  param_order: string[];
}

export interface NotificationTemplateType {
  title: LocalizedContentType;
  message: LocalizedContentType;
  utility?: NotificationUtilityConfigType;
}

export interface NotificationTemplatesTypes {
  // @ts-expect-error 'mark as error'
  [key in NotificationEnum]: NotificationTemplateType;
}

export interface ITemplateSchema extends Document {
  notifications: {
    [key in NotificationEnum]: NotificationTemplateType;
  };
  security_questions: Record<string, LocalizedContentType>;
}

const localizedContentSchema = new Schema<LocalizedContentType>({
  en: { type: String, required: true },
  es: { type: String, required: true },
  pt: { type: String, required: true }
});

const notificationSchema = new Schema<NotificationTemplateType>({
  title: { type: localizedContentSchema, required: true },
  message: { type: localizedContentSchema, required: true },
  utility: {
    type: new Schema<NotificationUtilityConfigType>(
      {
        enabled: { type: Boolean, required: true },
        template_key: { type: String, required: true },
        param_order: { type: [String], required: true }
      },
      { _id: false }
    ),
    required: false
  }
});

const templateSchema = new Schema<ITemplateSchema>({
  notifications: {
    incoming_transfer: { type: notificationSchema, required: true },
    incoming_transfer_w_note: { type: notificationSchema, required: true },
    incoming_transfer_external: { type: notificationSchema, required: true },
    swap: { type: notificationSchema, required: true },
    mint: { type: notificationSchema, required: true },
    outgoing_transfer: { type: notificationSchema, required: true },
    wallet_creation: { type: notificationSchema, required: true },
    wallet_already_exists: { type: notificationSchema, required: true },
    user_balance_not_enough: { type: notificationSchema, required: true },
    no_valid_blockchain_conditions: { type: notificationSchema, required: true },
    concurrent_operation: { type: notificationSchema, required: true },
    internal_error: { type: notificationSchema, required: true },
    daily_limit_reached: { type: notificationSchema, required: true },
    amount_outside_limits: { type: notificationSchema, required: true },
    aave_supply_created: { type: notificationSchema, required: true },
    aave_supply_modified: { type: notificationSchema, required: true },
    aave_supply_info: { type: notificationSchema, required: true },
    aave_supply_info_no_data: { type: notificationSchema, required: true },
    chatterpoints_operation: { type: notificationSchema, required: true },
    cross_chain_disabled: { type: notificationSchema, required: true },
    polymarket_account_created: { type: notificationSchema, required: false },
    polymarket_order_placed: { type: notificationSchema, required: false },
    polymarket_order_cancelled: { type: notificationSchema, required: false },
    polymarket_order_failed: { type: notificationSchema, required: false },
    polymarket_terms_not_accepted: { type: notificationSchema, required: false },
    polymarket_account_not_found: { type: notificationSchema, required: false },
    polymarket_bridge_initiated: { type: notificationSchema, required: false },
    polymarket_disabled: { type: notificationSchema, required: false }
  },
  security_questions: { type: Map, of: localizedContentSchema, required: false }
});

export const TemplateType = model<ITemplateSchema>('Template', templateSchema, 'templates');
