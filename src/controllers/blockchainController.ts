import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import Blockchain, { IBlockchain } from '../models/blockchainModel';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';

type BlockchainParams = { id: string };
type BlockchainBody = IBlockchain | Partial<IBlockchain>;

/**
 * Creates a new blockchain entry in the database.
 * @param {FastifyRequest} request - The FastifyRequest object containing the blockchain data.
 * @param {FastifyReply} reply - The FastifyReply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise resolving to the FastifyReply object with the creation status.
 */
export const createBlockchain = async (
  request: FastifyRequest<{ Body: IBlockchain }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const newBlockchain = new Blockchain(request.body);
    await newBlockchain.save();
    Logger.log('createBlockchain', 'Blockchain Saved');
    return await returnSuccessResponse(
      reply,
      'Blockchain created successfully',
      newBlockchain.toJSON()
    );
  } catch (error) {
    Logger.error('createBlockchain', 'Error creating blockchain');
    Logger.error('createBlockchain', 'Error details: ', error);
    return returnErrorResponse(reply, 400, 'Failed to create blockchain');
  }
};

/**
 * Retrieves all blockchain entries from the database.
 * @param {FastifyRequest} request - The FastifyRequest object.
 * @param {FastifyReply} reply - The FastifyReply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise resolving to the FastifyReply object with all blockchains.
 */
export const getAllBlockchains = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    const blockchains = await Blockchain.find();
    return await returnSuccessResponse(reply, 'Blockchains fetched successfully', {
      blockchains
    });
  } catch (error) {
    Logger.error('getAllBlockchains', 'Error fetching blockchains');
    Logger.error('getAllBlockchains', 'Error details: ', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch blockchains');
  }
};

/**
 * Retrieves a specific blockchain entry by its ID.
 * @param {FastifyRequest} request - The FastifyRequest object containing the blockchain ID.
 * @param {FastifyReply} reply - The FastifyReply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise resolving to the FastifyReply object with the blockchain data.
 */
export const getBlockchainById = async (
  request: FastifyRequest<{ Params: BlockchainParams }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params;
  try {
    const blockchain = await Blockchain.findById(id);
    if (!blockchain) {
      Logger.warn('getBlockchainById', 'Blockchain not found');
      return await returnErrorResponse(reply, 404, 'Blockchain not found');
    }
    return await returnSuccessResponse(
      reply,
      'Blockchain fetched successfully',
      blockchain.toJSON()
    );
  } catch (error) {
    Logger.error('getBlockchainById', 'Error fetching blockchain');
    Logger.error('getBlockchainById', 'Error details: ', error);
    return returnErrorResponse(reply, 400, 'Failed to fetch blockchain');
  }
};

/**
 * Updates a specific blockchain entry by its ID.
 * @param {FastifyRequest} request - The FastifyRequest object containing the blockchain ID and update data.
 * @param {FastifyReply} reply - The FastifyReply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise resolving to the FastifyReply object with the updated blockchain.
 */
export const updateBlockchain = async (
  request: FastifyRequest<{ Params: BlockchainParams; Body: BlockchainBody }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { id } = request.params;
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const updatedBlockchain = await Blockchain.findByIdAndUpdate(id, request.body, {
      new: true
    });
    if (!updatedBlockchain) {
      Logger.warn('updateBlockchain', 'Blockchain not found');
      return await returnErrorResponse(reply, 404, 'Blockchain not found');
    }
    return await returnSuccessResponse(
      reply,
      'Blockchain updated successfully',
      updatedBlockchain.toJSON()
    );
  } catch (error) {
    Logger.error('updateBlockchain', 'Error updating blockchain');
    Logger.error('updateBlockchain', 'Error details: ', error);
    return returnErrorResponse(reply, 400, 'Failed to update blockchain');
  }
};
