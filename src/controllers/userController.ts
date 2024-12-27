import { FastifyReply, FastifyRequest } from 'fastify';

import { User, IUser } from '../models/user';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

/**
 * Creates a new user in the database.
 * @param {FastifyRequest<{ Body: IUser }>} request - The Fastify request object containing the user data in the body.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object.
 */
export const createUser = async (
  request: FastifyRequest<{ Body: IUser }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }
    const newUser = new User(request.body);
    await newUser.save();
    return await returnSuccessResponse(reply, 'User created successfully', { user: newUser });
  } catch (error) {
    console.error('Error creating user:', error);
    return returnErrorResponse(reply, 400, 'Bad Request');
  }
};

/**
 * Retrieves all users from the database.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing all users.
 */
export const getAllUsers = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const users = await User.find();
    return await returnSuccessResponse(reply, 'Users fetched successfully', { users });
  } catch (error) {
    console.error('Error fetching users:', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch users');
  }
};

/**
 * Retrieves a user by their ID from the database.
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the user ID in the params.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the found user or an error message.
 */
export const getUserById = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const user = await User.findById(id);

    if (!user) {
      console.warn('User not found');
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    return await returnSuccessResponse(reply, 'User fetched successfully', user.toJSON());
  } catch (error) {
    console.error('Error fetching user:', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch user');
  }
};

/**
 * Updates a user by their ID in the database.
 * @param {FastifyRequest<{ Params: { id: string }, Body: Partial<IUser> }>} request - The Fastify request object containing the user ID in the params and update data in the body.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the updated user or an error message.
 */
export const updateUser = async (
  request: FastifyRequest<{ Params: { id: string }; Body: Partial<IUser> }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const updatedUser = await User.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedUser) {
      console.warn('User not found');
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    return await returnSuccessResponse(reply, 'User updated successfully', updatedUser.toJSON());
  } catch (error) {
    console.error('Error updating user:', error);
    return returnErrorResponse(reply, 400, 'Bad Request');
  }
};

/**
 * Deletes a user by their ID from the database.
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the user ID in the params.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing a success message or an error message.
 */
export const deleteUser = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const deletedUser = await User.findByIdAndDelete(id);

    if (!deletedUser) {
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    return await returnSuccessResponse(reply, 'User deleted successfully');
  } catch (error) {
    console.error('Error deleting user:', error);
    return returnErrorResponse(reply, 400, 'Bad Request');
  }
};
