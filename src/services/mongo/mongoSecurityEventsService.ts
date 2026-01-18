import { Logger } from '../../helpers/loggerHelper';
import {
  type SecurityEventChannel,
  SecurityEventModel,
  type SecurityEventType
} from '../../models/securityEventModel';

export interface SecurityEventInsert {
  user_id: string;
  event_type: SecurityEventType;
  channel?: SecurityEventChannel;
  metadata?: Record<string, unknown>;
}

export const mongoSecurityEventsService = {
  /**
   * Log a security event
   */
  logSecurityEvent: async (event: SecurityEventInsert): Promise<void> => {
    try {
      await SecurityEventModel.create({
        user_id: event.user_id,
        event_type: event.event_type,
        channel: event.channel ?? 'unknown',
        metadata: event.metadata ?? {},
        created_at: new Date()
      });
    } catch (error) {
      Logger.error(
        'mongoSecurityEventsService',
        'logSecurityEvent',
        `Failed to log security event`,
        { event, error }
      );
    }
  }
};
