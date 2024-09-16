import { FastifyInstance } from 'fastify';

import { getNFT, mintNFT, getAllNFTs, getLastNFT, mintExistingNFT } from '../controllers/nftController';

const nftRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/nft/', mintNFT);
    fastify.post('/mint_existing/', mintExistingNFT);
    fastify.get('/nfts/', getAllNFTs);
    fastify.get('/nft/:id', getNFT);
    fastify.get('/last_nft/', getLastNFT);
};

export default nftRoutes;
