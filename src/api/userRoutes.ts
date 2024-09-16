import { FastifyInstance } from 'fastify';

import {
  createUser,
  updateUser,
  deleteUser,
  getAllUsers,
  getUserById,
} from '../controllers/userController';

/**
 * Configures routes related to users.
 * @param fastify - Fastify instance
 */
const userRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
  // Route to create a new user
  fastify.post('/users/', createUser);
  // Route to get all users
  fastify.get('/users/', getAllUsers);
  // Route to get a user by their ID
  fastify.get('/users/:id', getUserById);
  // Route to update a user
  fastify.put('/users/:id', updateUser);
  // Route to delete a user
  fastify.delete('/users/:id', deleteUser);
};

export default userRoutes;