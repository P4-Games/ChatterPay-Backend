import { FastifyReply } from 'fastify';

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
 * @param {FastifyReply} reply - The Fastify reply object.
 * @param {number} code - The HTTP status code.
 * @param {string} message - The error message.
 * @param {string} [details] - Optional additional details for the error response.
 * @returns {Promise<FastifyReply>} The Fastify reply object with the error response.
 */
export function returnErrorResponse(
  reply: FastifyReply,
  code: number,
  message: string,
  details?: string
) {
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

export function returnErrorResponse500(reply: FastifyReply) {
  return returnErrorResponse(reply, 500, 'Internal Server Error');
}
