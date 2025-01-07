import { FastifyInstance } from 'fastify';

import {
  createUser,
  deleteUser,
  updateUser,
  getAllUsers,
  getUserById
} from '../controllers/userController';

/**
 * Configures routes related to users.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
const userRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to create a new user
   * @route POST /users/
   */
  fastify.post('/users/', createUser);

  /**
   * Route to get all users
   * @route GET /users/
   */
  fastify.get('/users/', getAllUsers);

  /**
   * Route to get a user by their ID
   * @route GET /users/:id
   */
  fastify.get('/users/:id', getUserById);

  /**
   * Route to update a user
   * @route PUT /users/:id
   */
  fastify.put('/users/:id', updateUser);

  /**
   * Route to delete a user
   * @route DELETE /users/:id
   */
  fastify.delete('/users/:id', deleteUser);
};

export default userRoutes;
