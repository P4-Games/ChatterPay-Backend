import { type Document, model, Schema } from 'mongoose';

export type SecurityEventType =
  | 'PIN_SET'
  | 'PIN_RESET'
  | 'QUESTIONS_SET'
  | 'QUESTIONS_UPDATED'
  | 'PIN_VERIFY_FAILED'
  | 'PIN_BLOCKED';

export type SecurityEventChannel = 'bot' | 'frontend' | 'unknown';

export interface ISecurityEvent extends Document {
  user_id: string;
  event_type: SecurityEventType;
  channel?: SecurityEventChannel;
  metadata?: Record<string, unknown>;
  created_at: Date;
}

const securityEventSchema = new Schema<ISecurityEvent>({
  user_id: { type: String, required: true, index: true },
  event_type: { type: String, required: true },
  channel: { type: String, required: false, default: 'unknown' },
  metadata: { type: Schema.Types.Mixed, required: false },
  created_at: { type: Date, required: true, default: Date.now, index: true }
});

export const SecurityEventModel = model<ISecurityEvent>(
  'SecurityEvent',
  securityEventSchema,
  'security_events'
);
