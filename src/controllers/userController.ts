import { FastifyReply, FastifyRequest } from 'fastify';

import { User, IUser } from '../models/user';

/**
 * Creates a new user in the database.
 * @param {FastifyRequest<{ Body: IUser }>} request - The Fastify request object containing the user data in the body.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object.
 */
export const createUser = async (
    request: FastifyRequest<{ Body: IUser }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    try {
        const newUser = new User(request.body);
        await newUser.save();
        return await reply.status(201).send(newUser);
    } catch (error) {
        console.error('Error creating user:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
    reply: FastifyReply,
): Promise<FastifyReply> => {
    try {
        const users = await User.find();
        return await reply.status(200).send(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { id } = request.params as { id: string };

    try {
        const user = await User.findById(id);

        if (!user) {
            return await reply.status(404).send({ message: 'User not found' });
        }

        return await reply.status(200).send(user);
    } catch (error) {
        console.error('Error fetching user:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { id } = request.params as { id: string };

    try {
        const updatedUser = await User.findByIdAndUpdate(id, request.body, { new: true });

        if (!updatedUser) {
            return await reply.status(404).send({ message: 'User not found' });
        }

        return await reply.status(200).send(updatedUser);
    } catch (error) {
        console.error('Error updating user:', error);
        return reply.status(400).send({ message: 'Bad Request' });
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
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { id } = request.params as { id: string };

    try {
        const deletedUser = await User.findByIdAndDelete(id);

        if (!deletedUser) {
            return await reply.status(404).send({ message: 'User not found' });
        }

        return await reply.status(200).send({ message: 'User deleted' });
    } catch (error) {
        console.error('Error deleting user:', error);
        return reply.status(400).send({ message: 'Bad Request' });
    }
};
