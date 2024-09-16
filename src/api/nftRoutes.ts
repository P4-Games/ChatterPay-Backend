import { FastifyInstance } from 'fastify';

import { getNFT, mintNFT, getAllNFTs } from '../controllers/nftController';

/**
 * Configures routes related to NFTs (Non-Fungible Tokens).
 * @param fastify - Fastify instance
 */
const nftRoutes: (fastify: FastifyInstance) => Promise<void> = async (fastify) => {
    // Route to mint a new NFT
    fastify.post('/nft/', mintNFT);

    // Route to get all NFTs
    fastify.get('/nfts/', getAllNFTs);

    // Route to get a specific NFT by its ID
    fastify.get('/nft/:id', getNFT);
};

export default nftRoutes;