import { FastifyInstance } from 'fastify';

import {
  getNftById,
  getAllNFTs,
  getLastNFT,
  getNftList,
  generateNftCopy,
  generateNftOriginal,
  getNftMetadataRequiredByOpenSea
} from '../controllers/nftController';

/**
 * Configures routes related to NFTs.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>} Resolves once all routes are registered
 */
const nftRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to mint a new NFT.
   * @route POST /nft/
   * @returns {Object} The minted NFT details
   */
  fastify.post('/nft/', generateNftOriginal);

  /**
   * Route to mint an existing NFT by copying it.
   * @route POST /mint_existing/
   * @returns {Object} The minted (copied) NFT details
   */
  fastify.post('/mint_existing/', generateNftCopy);

  /**
   * Route to get all NFTs.
   * @route GET /nfts/
   * @returns {Array} List of all NFTs
   */
  fastify.get('/nfts/', getAllNFTs);

  /**
   * Route to get a specific NFT by its ID.
   * @route GET /nft/:id
   * @param {string} id - The unique identifier of the NFT
   * @returns {Object} The details of the specified NFT
   */
  fastify.get('/nft/:id', getNftById);

  /**
   * Route to get NFT metadata required by OpenSea.
   * @route GET /nft/metadata/opensea/:id
   * @param {string} id - The unique identifier of the NFT
   * @returns {Object} The metadata required by OpenSea for the NFT
   */
  fastify.get('/nft/metadata/opensea/:id', getNftMetadataRequiredByOpenSea);

  /**
   * Route to get the most recent NFT.
   * @route GET /last_nft/
   * @returns {Object} The last minted NFT
   */
  fastify.get('/last_nft/', getLastNFT);

  /**
   * Route to get NFT information by its token ID.
   * @route GET /nft_info/:tokenId
   * @param {number} tokenId - The token ID of the NFT
   * @returns {Object} Original NFT information
   * @returns {Array} List of NFTs copied from the original NFT if the ID is from the original
   * @returns {Object} Copied NFT information if the NFT is a copy
   */
  fastify.get('/nft_info/:tokenId', getNftList);
};

export default nftRoutes;
