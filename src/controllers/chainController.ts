/**
 * Chain Controller
 *
 * Handles endpoints for fetching supported cross-chain networks.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { getLifiChains, type LifiChain } from '../services/lifi';

/**
 * GET /chains
 * Returns list of supported destination networks for cross-chain transfers
 */
export const getChains = async (request: FastifyRequest, reply: FastifyReply) => {
  const logKey = '[op:get-chains]';

  try {
    Logger.info('getChains', logKey, 'Fetching supported chains from Li.Fi');

    const chains: LifiChain[] = await getLifiChains(logKey);

    // Map to simplified response format
    const response = chains.map((chain: LifiChain) => ({
      key: chain.key,
      name: chain.name.toLowerCase(),
      chainType: chain.chainType,
      chainId: chain.id,
      coin: chain.coin,
      logoURI: chain.logoURI
    }));

    return returnSuccessResponse(reply, 'Chains fetched successfully', { chains: response });
  } catch (error) {
    Logger.error('getChains', logKey, error);
    return returnErrorResponse('getChains', logKey, reply, 500, 'Failed to fetch chains');
  }
};
