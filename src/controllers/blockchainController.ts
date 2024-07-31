import { FastifyRequest, FastifyReply } from 'fastify';
import Blockchain, { IBlockchain } from '../models/blockchain';

// Crear una nueva blockchain
export const createBlockchain = async (request: FastifyRequest<{ Body: IBlockchain }>, reply: FastifyReply) => {
  try {
    const newBlockchain = new Blockchain(request.body);
    await newBlockchain.save();
    return reply.status(201).send(newBlockchain);
  } catch (error) {
    console.error('Error creating blockchain:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener todas las blockchains
export const getAllBlockchains = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const blockchains = await Blockchain.find();
    return reply.status(200).send(blockchains);
  } catch (error) {
    console.error('Error fetching blockchains:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener una blockchain por ID
export const getBlockchainById = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const blockchain = await Blockchain.findById(id);

    if (!blockchain) {
      return reply.status(404).send({ message: 'Blockchain not found' });
    }

    return reply.status(200).send(blockchain);
  } catch (error) {
    console.error('Error fetching blockchain:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Actualizar una blockchain por ID
export const updateBlockchain = async (request: FastifyRequest<{ Params: { id: string }, Body: Partial<IBlockchain> }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const updatedBlockchain = await Blockchain.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedBlockchain) {
      return reply.status(404).send({ message: 'Blockchain not found' });
    }

    return reply.status(200).send(updatedBlockchain);
  } catch (error) {
    console.error('Error updating blockchain:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Eliminar una blockchain por ID
export const deleteBlockchain = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
  const { id } = request.params as { id: string };

  try {
    const deletedBlockchain = await Blockchain.findByIdAndDelete(id);

    if (!deletedBlockchain) {
      return reply.status(404).send({ message: 'Blockchain not found' });
    }

    return reply.status(200).send({ message: 'Blockchain deleted' });
  } catch (error) {
    console.error('Error deleting blockchain:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

// Obtener RPC, entryPoint y signingKey por chain_id
export const getBlockchainDetailsByChainId = async (chain_id: number) => {
  try {
    const blockchain = await Blockchain.findOne({ chain_id });

    if (!blockchain) {
      throw new Error('Blockchain not found');
    }

    const { rpc, entryPoint, signingKey } = blockchain;

    return { rpc, entryPoint, signingKey };
  } catch (error) {
    console.error('Error fetching blockchain details:', error);
    throw new Error('Failed to fetch blockchain details');
  }
};