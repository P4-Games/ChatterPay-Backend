import { FastifyReply, FastifyRequest } from 'fastify';

import Blockchain, { IBlockchain } from '../models/blockchain';

type BlockchainParams = { id: string };
type BlockchainBody = IBlockchain | Partial<IBlockchain>;

/**
 * Handles errors in blockchain operations.
 * @param error - The error object.
 * @param reply - The FastifyReply object.
 * @param operation - The operation being performed.
 */
const handleBlockchainError = (
    error: unknown,
    reply: FastifyReply,
    operation: string,
): FastifyReply => {
    console.error(`Error ${operation} blockchain:`, error);
    return reply.status(500).send({ message: 'Internal Server Error' });
};

/**
 * Creates a new blockchain entry in the database.
 * @param request - The FastifyRequest object containing the blockchain data.
 * @param reply - The FastifyReply object.
 * @returns A promise resolving to the FastifyReply object.
 */
export const createBlockchain = async (
    request: FastifyRequest<{ Body: IBlockchain }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    try {
        const newBlockchain = new Blockchain(request.body);
        await newBlockchain.save();
        return await reply.status(201).send(newBlockchain);
    } catch (error) {
        return handleBlockchainError(error, reply, 'creating');
    }
};

/**
 * Retrieves all blockchain entries from the database.
 * @param request - The FastifyRequest object.
 * @param reply - The FastifyReply object.
 * @returns A promise resolving to the FastifyReply object.
 */
export const getAllBlockchains = async (
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    try {
        const blockchains = await Blockchain.find();
        return await reply.status(200).send(blockchains);
    } catch (error) {
        return handleBlockchainError(error, reply, 'fetching');
    }
};

/**
 * Retrieves a specific blockchain entry by its ID.
 * @param request - The FastifyRequest object containing the blockchain ID.
 * @param reply - The FastifyReply object.
 * @returns A promise resolving to the FastifyReply object.
 */
export const getBlockchainById = async (
    request: FastifyRequest<{ Params: BlockchainParams }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { id } = request.params;
    try {
        const blockchain = await Blockchain.findById(id);
        if (!blockchain) {
            return await reply.status(404).send({ message: 'Blockchain not found' });
        }
        return await reply.status(200).send(blockchain);
    } catch (error) {
        return handleBlockchainError(error, reply, 'fetching');
    }
};

/**
 * Updates a specific blockchain entry by its ID.
 * @param request - The FastifyRequest object containing the blockchain ID and update data.
 * @param reply - The FastifyReply object.
 * @returns A promise resolving to the FastifyReply object.
 */
export const updateBlockchain = async (
    request: FastifyRequest<{ Params: BlockchainParams; Body: BlockchainBody }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { id } = request.params;
    try {
        const updatedBlockchain = await Blockchain.findByIdAndUpdate(id, request.body, {
            new: true,
        });
        if (!updatedBlockchain) {
            return await reply.status(404).send({ message: 'Blockchain not found' });
        }
        return await reply.status(200).send(updatedBlockchain);
    } catch (error) {
        return handleBlockchainError(error, reply, 'updating');
    }
};

/**
 * Deletes a specific blockchain entry by its ID.
 * @param request - The FastifyRequest object containing the blockchain ID.
 * @param reply - The FastifyReply object.
 * @returns A promise resolving to the FastifyReply object.
 */
export const deleteBlockchain = async (
    request: FastifyRequest<{ Params: BlockchainParams }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    const { id } = request.params;
    try {
        const deletedBlockchain = await Blockchain.findByIdAndDelete(id);
        if (!deletedBlockchain) {
            return await reply.status(404).send({ message: 'Blockchain not found' });
        }
        return await reply.status(200).send({ message: 'Blockchain deleted' });
    } catch (error) {
        return handleBlockchainError(error, reply, 'deleting');
    }
};

/**
 * Retrieves specific blockchain details by chain ID.
 * @param chain_id - The chain ID of the blockchain.
 * @returns A promise resolving to an object containing rpc, entryPoint, and signingKey.
 * @throws An error if the blockchain is not found or if there's an error fetching the details.
 */
export const getBlockchainDetailsByChainId = async (
    chain_id: number,
): Promise<{ rpc: string; entryPoint: string; signingKey: string }> => {
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
