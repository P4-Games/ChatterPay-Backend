import axios from 'axios';
import {
  BOT_API_URL,
  BOT_NOTIFICATIONS_ENABLED,
  GCP_CLOUD_TRACE_ENABLED
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import { isValidPhoneNumber } from '../../helpers/validationHelper';
import type { chatizaloOperatorReply } from '../../types/chatizaloType';

const getSafePayloadForLogs = (payload: chatizaloOperatorReply) => ({
  ...payload,
  data_token: '[REDACTED]'
});

const redactDataTokenInString = (value: string): string =>
  value.replace(/("data_token"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');

const redactDataToken = (value: unknown): unknown => {
  if (typeof value === 'string') return redactDataTokenInString(value);
  if (Array.isArray(value)) return value.map((item) => redactDataToken(item));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj).map(([key, val]) => [
      key,
      key === 'data_token' ? '[REDACTED]' : redactDataToken(val)
    ]);
    return Object.fromEntries(entries);
  }
  return value;
};

const stringifyErrorData = (data: unknown): string => {
  if (typeof data === 'string') return redactDataTokenInString(data);
  try {
    return JSON.stringify(redactDataToken(data));
  } catch {
    return 'Unserializable response body';
  }
};

export const chatizaloService = {
  /**
   * Sends an operator reply to the API.
   *
   * @param {chatizaloOperatorReply} payload - The payload containing the operator's reply details.
   * @param {string} [traceHeader] - Optional trace header for Google Cloud Trace integration.
   * @returns {Promise<string>} The API response as a string.
   */
  sendBotNotification: async (
    payload: chatizaloOperatorReply,
    traceHeader?: string
  ): Promise<string> => {
    const safePayload = getSafePayloadForLogs(payload);
    try {
      if (!BOT_NOTIFICATIONS_ENABLED) {
        Logger.info(
          'sendBotNotification',
          `Bot notifications are disabled. Omitted payload: ${JSON.stringify(safePayload)}`
        );
        return '';
      }

      if (!isValidPhoneNumber(payload.channel_user_id)) {
        Logger.info(
          'sendBotNotification',
          `Bot notifications are enabled, but ${payload.channel_user_id} is not a valid phone number!. Omitted payload: ${JSON.stringify(safePayload)}`
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
      Logger.log('sendBotNotification', 'Chatizalo request/response:', {
        requestBody: safePayload,
        responseBody: response.data
      });
      return response.data;
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const statusCode = error.response?.status;
        const responseBody = redactDataToken(error.response?.data);

        Logger.error('sendBotNotification', 'Chatizalo request failed:', {
          requestBody: safePayload,
          statusCode,
          responseBody
        });

        const responseBodyText = stringifyErrorData(responseBody);
        throw new Error(`Chatizalo API error (${statusCode ?? 'NO_STATUS'}): ${responseBodyText}`);
      }

      Logger.error('sendBotNotification', 'Unexpected error sending Chatizalo notification:', {
        requestBody: safePayload,
        message: (error as Error).message
      });
      throw error;
    }
  }
};
