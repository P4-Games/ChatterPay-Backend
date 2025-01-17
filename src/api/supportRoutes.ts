import { FastifyInstance } from 'fastify';

import {
  resetUsersOperations,
  checkUsersWithOpenOperations,
  resetUsersOperationsWithTimeCondition
} from '../controllers/supportController';

/**
 * Registers support-related routes for the Fastify application.
 *
 * - GET `/support/check_users_open_operations`: Retrieves a list of users with operations in progress.
 * - POST `/support/reset_users_operations_counter`: Resets all operations in progress for all users.
 *
 * @param {FastifyInstance} fastify - The Fastify instance used to register the routes.
 * @returns {Promise<void>} Resolves once the routes are registered.
 */
const supportRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to retrieve users with open operations.
   * @route GET /support/check_users_open_operations
   * @returns {Object} List of users with ongoing operations.
   * @example
   * // Example response:
   * {
   *   "success": true,
   *   "data": [
   *     {
   *       "name": "John Doe",
   *       "email": "johndoe@example.com",
   *       "operations_in_progress": {
   *         "transfer": 1,
   *         "swap": 0,
   *         "mint_nft": 1,
   *         "mint_nft_copy": 0,
   *         "withdraw_all": 0
   *       }
   *     }
   *   ]
   * }
   */
  fastify.get('/support/check_users_open_operations', checkUsersWithOpenOperations);

  /**
   * Route to reset all users' operations counters.
   * @route POST /support/reset_users_operations_counter
   * @returns {Object} Number of users whose operations were reset.
   * @example
   * // Example response:
   * {
   *   "success": true,
   *   "message": "50 users' operations has been reset to 0."
   * }
   */
  fastify.put('/support/reset_users_operations_counter', resetUsersOperations);

  /**
   * Route to reset users' operations counters with a time condition.
   * Resets operations in progress for users only if their `last_operation_date`
   * is older than the defined threshold (e.g., 30 minutes).
   *
   * @route PUT /support/reset_users_operations_with_time_condition
   * @returns {Object} Number of users whose operations were reset.
   * @example
   * // Example response:
   * {
   *   "success": true,
   *   "message": "30 users' operations have been reset to 0 based on the time condition."
   * }
   */
  fastify.put(
    '/support/reset_users_operations_time_condition',
    resetUsersOperationsWithTimeCondition
  );
};

export default supportRoutes;
