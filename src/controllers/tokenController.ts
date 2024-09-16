import { FastifyReply, FastifyRequest } from 'fastify';
import Token, { IToken } from '../models/token';

/**
 * Creates a new token
 * @param {FastifyRequest<{ Body: IToken }>} request - The Fastify request object containing the token data in the body
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object
 */
export const createToken = async (request: FastifyRequest<{ Body: IToken }>, reply: FastifyReply): Promise<FastifyReply> => {
  try {
    const newToken = new Token(request.body);
    await newToken.save();
    return await reply.status(201).send(newToken);
  } catch (error) {
    console.error('Error creating token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Retrieves all tokens
 * @param {FastifyRequest} request - The Fastify request object
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing all tokens
 */
export const getAllTokens = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
  try {
    const tokens = await Token.find();
    return await reply.status(200).send(tokens);
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Retrieves a token by its ID
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the token ID in the params
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the found token or an error message
 */
export const getTokenById = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const token = await Token.findById(id);

    if (!token) {
      return await reply.status(404).send({ message: 'Token not found' });
    }

    return await reply.status(200).send(token);
  } catch (error) {
    console.error('Error fetching token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Updates a token by its ID
 * @param {FastifyRequest<{ Params: { id: string }, Body: Partial<IToken> }>} request - The Fastify request object containing the token ID in the params and update data in the body
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the updated token or an error message
 */
export const updateToken = async (request: FastifyRequest<{ Params: { id: string }, Body: Partial<IToken> }>, reply: FastifyReply): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const updatedToken = await Token.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedToken) {
      return await reply.status(404).send({ message: 'Token not found' });
    }

    return await reply.status(200).send(updatedToken);
  } catch (error) {
    console.error('Error updating token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Deletes a token by its ID
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the token ID in the params
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing a success message or an error message
 */
export const deleteToken = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const deletedToken = await Token.findByIdAndDelete(id);

    if (!deletedToken) {
      return await reply.status(404).send({ message: 'Token not found' });
    }

    return await reply.status(200).send({ message: 'Token deleted' });
  } catch (error) {
    console.error('Error deleting token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};