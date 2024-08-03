import { FastifyInstance } from 'fastify';
import { issueTokens } from '../controllers/demoERC20Controller';

export const demoERC20Routes = async (fastify: FastifyInstance) => {
    fastify.post('/issue', issueTokens);
};
