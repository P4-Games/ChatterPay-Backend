import { FastifyInstance } from 'fastify';
import { balanceByPhoneNumber, issueTokens, walletBalance } from '../controllers/demoERC20Controller';

export const demoERC20Routes = async (fastify: FastifyInstance) => {
    fastify.post('/issue/', issueTokens);
    fastify.get('/balance/:wallet/', walletBalance);
    fastify.get('/balance_by_phone/:phone/', balanceByPhoneNumber);
};
