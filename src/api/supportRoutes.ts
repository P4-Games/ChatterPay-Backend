import type { FastifyInstance } from 'fastify';

import {
  checkUsersWithOpenOperations,
  clearAllCaches,
  clearCacheByName,
  resetUsersOperationLimits,
  resetUsersOperations,
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
   *         "mint_nft_copy": 0
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

  /**
   * Route to clear the operations_counters field for a specific user.
   * This removes the full `operations_counters` object, resetting all usage tracking.
   *
   * @route PUT /support/reset_user_operations_counters
   * @bodyParam {string} phoneNumber - The user's phone number (sent in the request body or query depending on implementation).
   * @returns {Object} Confirmation message of successful reset.
   */
  fastify.put('/support/reset_user_operations_counters', resetUsersOperationLimits);

  /**
   * Route to clear all application-level caches.
   * Useful for maintenance or during testing to force cache repopulation.
   *
   * @route POST /support/clear_all_caches
   * @returns {Object} Success message
   * @example
   * {
   *   "success": true,
   *   "message": "All caches have been cleared."
   * }
   */
  fastify.post('/support/clear_all_caches', clearAllCaches);

  /**
   * Route to clear a specific named cache.
   *
   * @route POST /support/clear_cache_by_name
   * @bodyParam {string} cacheName - The name of the cache to clear. Must be one of the CacheNames enum values.
   * @returns {Object} Success or error message
   * @example
   * // Request body:
   * {
   *   "cacheName": "priceCache"
   * }
   *
   * // Response:
   * {
   *   "success": true,
   *   "message": "Cache \"priceCache\" has been cleared."
   * }
   */
  fastify.post('/support/clear_cache_by_name', clearCacheByName);
};

export default supportRoutes;
