import { FastifyReply, FastifyRequest } from 'fastify';

import Token, { IToken } from '../models/token';

// Crear un nuevo token
export const createToken = async (request: FastifyRequest<{ Body: IToken }>, reply: FastifyReply) => {
  try {
    const newToken = new Token(request.body);
    await newToken.save();
    return await reply.status(201).send(newToken);
  } catch (error) {
    console.error('Error creating token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener todos los tokens
export const getAllTokens = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const tokens = await Token.find();
    return await reply.status(200).send(tokens);
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener un token por ID
export const getTokenById = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
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

// Actualizar un token por ID
export const updateToken = async (request: FastifyRequest<{ Params: { id: string }, Body: Partial<IToken> }>, reply: FastifyReply) => {
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

// Eliminar un token por ID
export const deleteToken = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
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
