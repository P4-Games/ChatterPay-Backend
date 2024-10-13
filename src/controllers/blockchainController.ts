import { FastifyReply, FastifyRequest } from 'fastify';

import Blockchain, { IBlockchain } from '../models/blockchain';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

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
    return returnErrorResponse(reply, 400, `Error ${operation} blockchain`);
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
        console.log("Blockchain Saved")
        return await returnSuccessResponse(reply, 'Blockchain created successfully', newBlockchain.toJSON());
    } catch (error) {
        console.error("Error creating blockchain");
        console.error("Error details: ", error);
        return returnErrorResponse(reply, 400, 'Failed to create blockchain');
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
        return await returnSuccessResponse(reply, 'Blockchains fetched successfully', { blockchains });
    } catch (error) {
        console.error("Error fetching blockchains");
        console.error("Error details: ", error);
        return returnErrorResponse(reply, 400, 'Failed to fetch blockchains');
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
            console.warn("Blockchain not found");
            return await returnErrorResponse(reply, 404, 'Blockchain not found');
        }
        return await returnSuccessResponse(reply, 'Blockchain fetched successfully', blockchain.toJSON());
    } catch (error) {
        console.error("Error fetching blockchain");
        console.error("Error details: ", error);
        return returnErrorResponse(reply, 400, 'Failed to fetch blockchain');
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
            console.warn("Blockchain not found");
            return await returnErrorResponse(reply, 404, 'Blockchain not found');
        }
        return await returnSuccessResponse(reply, 'Blockchain updated successfully', updatedBlockchain.toJSON());
    } catch (error) {
        console.error("Error updating blockchain");
        console.error("Error details: ", error);
        return returnErrorResponse(reply, 400, 'Failed to update blockchain');
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
            console.warn("Blockchain not found");
            return await returnErrorResponse(reply, 404, 'Blockchain not found');
        }
        return await returnSuccessResponse(reply, 'Blockchain deleted successfully');
    } catch (error) {
        console.error("Error deleting blockchain");
        console.error("Error details: ", error);
        return returnErrorResponse(reply, 400, 'Failed to delete blockchain');
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
