import type { FastifyInstance } from 'fastify';

import {
  createUser,
  deleteUser,
  getAllUsers,
  getUserById,
  updateUser
} from '../controllers/userController';

/**
 * Configures routes related to users.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const userRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new user
   * @route POST /users/
   * @returns {Object} The details of the created user
   */
  fastify.post('/users/', createUser);

  /**
   * Route to get all users
   * @route GET /users/
   * @returns {Array} List of all users
   */
  fastify.get('/users/', getAllUsers);

  /**
   * Route to get a user by their ID
   * @route GET /users/:id
   * @param {string} id - The unique identifier of the user
   * @returns {Object} The details of the specified user
   */
  fastify.get('/users/:id', getUserById);

  /**
   * Route to update a user
   * @route PUT /users/:id
   * @param {string} id - The unique identifier of the user to update
   * @returns {Object} The updated user details
   */
  fastify.put('/users/:id', updateUser);

  /**
   * Route to delete a user
   * @route DELETE /users/:id
   * @param {string} id - The unique identifier of the user to delete
   * @returns {Object} Confirmation of user deletion
   */
  fastify.delete('/users/:id', deleteUser);
};

export default userRoutes;
