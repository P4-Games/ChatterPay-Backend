import { FastifyRequest, FastifyReply } from 'fastify';
import User, { IUser } from '../models/user';

// Crear un nuevo usuario
export const createUser = async (request: FastifyRequest<{ Body: IUser }>, reply: FastifyReply) => {
  try {
    const newUser = new User(request.body);
    await newUser.save();
    return reply.status(201).send(newUser);
  } catch (error) {
    console.error('Error creating user:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener todos los usuarios
export const getAllUsers = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const users = await User.find();
    return reply.status(200).send(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener un usuario por ID
export const getUserById = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const user = await User.findById(id);

    if (!user) {
      return reply.status(404).send({ message: 'User not found' });
    }

    return reply.status(200).send(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Actualizar un usuario por ID
export const updateUser = async (request: FastifyRequest<{ Params: { id: string }, Body: Partial<IUser> }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const updatedUser = await User.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedUser) {
      return reply.status(404).send({ message: 'User not found' });
    }

    return reply.status(200).send(updatedUser);
  } catch (error) {
    console.error('Error updating user:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Eliminar un usuario por ID
export const deleteUser = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const deletedUser = await User.findByIdAndDelete(id);

    if (!deletedUser) {
      return reply.status(404).send({ message: 'User not found' });
    }

    return reply.status(200).send({ message: 'User deleted' });
  } catch (error) {
    console.error('Error deleting user:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};
