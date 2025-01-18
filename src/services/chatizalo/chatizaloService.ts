import axios from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { chatizaloOperatorReplyType } from '../../types/chatizaloType';
import {
  BOT_API_URL,
  GCP_CLOUD_TRACE_ENABLED,
  BOT_NOTIFICATIONS_ENABLED
} from '../../config/constants';

export const chatizaloService = {
  /**
   * Sends an operator reply to the API.
   *
   * @param {chatizaloOperatorReplyType} payload - The payload containing the operator's reply details.
   * @param {string} [traceHeader] - Optional trace header for Google Cloud Trace integration.
   * @returns {Promise<string>} The API response as a string.
   */
  sendBotNotification: async (
    payload: chatizaloOperatorReplyType,
    traceHeader?: string
  ): Promise<string> => {
    try {
      if (!BOT_NOTIFICATIONS_ENABLED) {
        Logger.info(
          'sendBotNotification',
          `Bot notifications are disabled. Omitted payload: ${JSON.stringify(payload)}`
        );
        return '';
      }

      const headers: { [key: string]: string } = {
        'Content-Type': 'application/json'
      };

      if (GCP_CLOUD_TRACE_ENABLED && traceHeader) {
        headers['X-Cloud-Trace-Context'] = traceHeader;
      }

      const sendMsgEndpint = `${BOT_API_URL}/chatbot/conversations/send-message`;
      const response = await axios.post(sendMsgEndpint, payload, {
        headers
      });
      Logger.log(
        'sendBotNotification',
        'API Response:',
        payload.channel_user_id,
        payload.message,
        response.data
      );
      return response.data;
    } catch (error) {
      Logger.error('sendBotNotification', (error as Error).message);
      throw error;
    }
  }
};
