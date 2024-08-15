import { FastifyInstance } from 'fastify';
import { getNFT, mintNFT } from '../controllers/nftController';

const nftRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/nft/', mintNFT);
    fastify.get('/nft/:id', getNFT);
    //fastify.post('/nft/transfer', transferNFT);
};

export default nftRoutes;
