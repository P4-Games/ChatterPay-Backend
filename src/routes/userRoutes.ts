import { FastifyInstance } from 'fastify';
import {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
} from '../controllers/userController';

const userRoutes = async (fastify: FastifyInstance) => {
  fastify.post('/users', createUser);
  fastify.get('/users', getAllUsers);
  fastify.get('/users/:id', getUserById);
  fastify.put('/users/:id', updateUser);
  fastify.delete('/users/:id', deleteUser);
};

export default userRoutes;
