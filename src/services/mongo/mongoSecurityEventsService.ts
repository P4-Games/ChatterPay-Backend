import { Logger } from '../../helpers/loggerHelper';
import {
  type ISecurityEvent,
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

export interface SecurityEventQuery {
  user_id: string;
  channel?: SecurityEventChannel;
  event_type?: SecurityEventType;
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
  },

  /**
   * Fetch security events for a user with optional filters.
   */
  listSecurityEvents: async (filters: SecurityEventQuery): Promise<ISecurityEvent[]> => {
    try {
      const query: Record<string, unknown> = { user_id: filters.user_id };

      if (filters.channel) {
        query.channel = filters.channel;
      }

      if (filters.event_type) {
        query.event_type = filters.event_type;
      }

      // @ts-expect-error
      return await SecurityEventModel.find(query).sort({ created_at: -1 }).lean();
    } catch (error) {
      Logger.error(
        'mongoSecurityEventsService',
        'listSecurityEvents',
        'Failed to fetch security events',
        { filters, error }
      );
      return [];
    }
  }
};
