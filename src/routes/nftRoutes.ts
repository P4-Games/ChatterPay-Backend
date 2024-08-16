import { FastifyInstance } from 'fastify';
import { getAllNFTs, getNFT, mintExistingNFT, mintNFT } from '../controllers/nftController';

const nftRoutes = async (fastify: FastifyInstance) => {
    fastify.post('/nft/', mintNFT);
    fastify.post('/mint_existing/', mintExistingNFT);
    fastify.get('/nfts/', getAllNFTs);
    fastify.get('/nft/:id', getNFT);
    //fastify.post('/nft/transfer', transferNFT);
};

export default nftRoutes;
