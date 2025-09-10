import { FastifyReply } from 'fastify';

import { Logger } from './loggerHelper';
import { isValidPhoneNumber } from './validationHelper';
import { sendInternalErrorNotification } from '../services/notificationService';

export interface SuccessResponse {
  status: 'success';
  data: {
    message: string;
    [key: string]: unknown;
  };
  timestamp: string;
}

export interface ErrorResponse {
  status: 'error';
  data: {
    code: number;
    message: string;
    details?: string;
  };
  timestamp: string;
}

/**
 * Returns a successful response.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @param {string} message - The success message.
 * @param {object} [additionalData] - Optional additional data to include in the response.
 * @returns {Promise<FastifyReply>} The Fastify reply object with the success response.
 */
export function returnSuccessResponse(
  reply: FastifyReply,
  message: string,
  additionalData?: { [key: string]: unknown }
) {
  const response: SuccessResponse = {
    status: 'success',
    data: {
      message,
      ...additionalData
    },
    timestamp: new Date().toISOString()
  };
  return reply.status(200).send(response);
}

/**
 * Returns an error response.
 * @param method
 * @param logKey
 * @param {FastifyReply} reply - The Fastify reply object.
 * @param {number} code - The HTTP status code.
 * @param {string} message - The error message.
 * @param {string} [details] - Optional additional details for the error response.
 * @returns {Promise<FastifyReply>} The Fastify reply object with the error response.
 */
export function returnErrorResponse(
  method: string,
  logKey: string,
  reply: FastifyReply,
  code: number,
  message: string,
  details?: string
) {
  if (code === 403) {
    Logger.warn(method, logKey || 'no-key', message, details || '');
  } else {
    Logger.error(method, logKey || 'no-key', message, details || '');
  }

  const response: ErrorResponse = {
    status: 'error',
    data: {
      code,
      message,
      details
    },
    timestamp: new Date().toISOString()
  };
  return reply.status(code).send(response);
}

/**
 *
 * @param method
 * @param logKey
 * @param reply
 * @param code
 * @param message
 * @param notifyUserWithBot
 * @param channel_user_id
 * @param details
 * @returns
 */
export async function returnErrorResponseAsSuccess(
  method: string,
  logKey: string,
  reply: FastifyReply,
  message: string,
  notifyUserWithBot: boolean,
  channel_user_id: string,
  details?: string
) {
  try {
    if (notifyUserWithBot && isValidPhoneNumber(channel_user_id)) {
      await sendInternalErrorNotification(channel_user_id, 0, '');
    }
  } catch (ex) {
    Logger.warn('returnErrorResponseAssSuccess', ex);
  }

  const response: ErrorResponse = {
    status: 'error',
    data: {
      code: 200,
      message,
      details
    },
    timestamp: new Date().toISOString()
  };

  return reply.status(200).send(response);
}

/**
 *
 * @param reply
 * @returns
 */
export function returnErrorResponse500(method: string, logKey: string, reply: FastifyReply) {
  return returnErrorResponse(method, logKey, reply, 500, 'Internal Server Error');
}
