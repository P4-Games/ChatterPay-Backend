import { FastifyInstance } from 'fastify';
import { getAllNFTs, getNFT, mintNFT } from '../controllers/nftController';

const nftRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/nft/', mintNFT);
    fastify.get('/nfts/', getAllNFTs);
    fastify.get('/nft/:id', getNFT);
};

export default nftRoutes;
