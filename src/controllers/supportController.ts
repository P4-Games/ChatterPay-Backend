import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { mongoUserService } from '../services/mongo/mongoUserService';
import {
  returnErrorResponse,
  returnSuccessResponse,
  returnErrorResponse500
} from '../helpers/requestHelper';

/**
 * Handler to check for users with open operations in progress.
 * Calls the service method to retrieve all users who have any operation in progress.
 *
 * @param {FastifyRequest} request - The incoming Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object for sending the response.
 * @returns {Promise<FastifyReply>} A response containing the list of users with open operations.
 */
export const checkUsersWithOpenOperations = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const users = await mongoUserService.getUsersWithOperationsInProgress();
    return await returnSuccessResponse(reply, '', { users });
  } catch (error) {
    Logger.error('checkUsersWithOpenOperations', error);
    return returnErrorResponse500(reply);
  }
};

/**
 * Handler to reset operations in progress for all users.
 * Calls the service method to set all fields in `operations_in_progress` to `0` for all users.
 *
 * @param {FastifyRequest} request - The incoming Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object for sending the response.
 * @returns {Promise<FastifyReply>} A response containing the number of users updated.
 */
export const resetUsersOperations = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const updatedCount = await mongoUserService.resetUserOperationsCounter();
    return await returnSuccessResponse(
      reply,
      `${updatedCount} users' operations has been reset to 0.`
    );
  } catch (error) {
    Logger.error('resetUsersOperations', error);
    return returnErrorResponse500(reply);
  }
};

/**
 * Handler to reset operations in progress for users with outdated operations.
 * Calls the service method to reset operations in progress to `0` for users whose
 * `last_operation_date` is older than the defined threshold (e.g., 30 minutes).
 *
 * @param {FastifyRequest} request - The incoming Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object for sending the response.
 * @returns {Promise<FastifyReply>} A response containing the number of users updated.
 */
export const resetUsersOperationsWithTimeCondition = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const updatedCount = await mongoUserService.resetUserOperationsCounterWithTimeCondition();
    return await returnSuccessResponse(
      reply,
      `${updatedCount} users' operations have been reset to 0 based on the time condition.`
    );
  } catch (error) {
    Logger.error('resetUsersOperationsWithTimeCondition', error);
    return returnErrorResponse500(reply);
  }
};

/**
 * Handler to clear all operation counters for one user
 * Sets the `operations_counters` field to an empty object for the user.
 *
 * @param {FastifyRequest} request - The incoming Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object for sending the response.
 * @returns {Promise<FastifyReply>} A response containing the number of users updated.
 */
export const resetUsersOperationLimits = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id } = request.body as { channel_user_id: string };

    await mongoUserService.resetrUserOperationCounters(channel_user_id);

    return await returnSuccessResponse(reply, `user operation counters have been cleared.`);
  } catch (error) {
    Logger.error('clearUsersOperationLimits', error);
    return returnErrorResponse500(reply);
  }
};
