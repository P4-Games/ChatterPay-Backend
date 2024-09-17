import { FastifyInstance } from 'fastify';

import { getNFT, mintNFT, getAllNFTs, getLastNFT, mintExistingNFT } from '../controllers/nftController';

/**
 * Configures routes related to NFTs.
 * @param {FastifyInstance} fastify - Fastify instance
 * @returns {Promise<void>}
 */
const nftRoutes = async (fastify: FastifyInstance): Promise<void> => {
    /**
     * Route to mint a new NFT.
     * @route POST /nft/
     */
    fastify.post('/nft/', mintNFT);

    /**
     * Route to mint an existing NFT.
     * @route POST /mint_existing/
     */
    fastify.post('/mint_existing/', mintExistingNFT);

    /**
     * Route to get all NFTs.
     * @route GET /nfts/
     */
    fastify.get('/nfts/', getAllNFTs);

    /**
     * Route to get a specific NFT by its ID.
     * @route GET /nft/:id
     */
    fastify.get('/nft/:id', getNFT);

    /**
     * Route to get the last NFT.
     * @route GET /last_nft/
     */
    fastify.get('/last_nft/', getLastNFT);
};

export default nftRoutes;
