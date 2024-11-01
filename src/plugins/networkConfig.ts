import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

import Token, { IToken } from '../models/token';
import { IBlockchain } from '../models/blockchain';
import { getNetworkConfig } from '../services/networkService';

// Extend the FastifyInstance interface to include our decorations
declare module 'fastify' {
  interface FastifyInstance {
    networkConfig: IBlockchain;
    tokens: IToken[];
    refreshTokens(): Promise<void>;
  }
}

export default fp(async (fastify: FastifyInstance) => {
    // Initialize tokens array
    const initialTokens = await Token.find();
    
    // Fetch network config once during server startup
    const networkConfig = await getNetworkConfig();
    
    // Decorate fastify instance with both config and tokens
    fastify.decorate('networkConfig', networkConfig);
    fastify.decorate('tokens', initialTokens);
    
    // Add method to refresh tokens
    fastify.decorate('refreshTokens', async () => {
        try {
            const updatedTokens = await Token.find();
            fastify.tokens = updatedTokens;
            fastify.log.info('Tokens refreshed successfully');
        } catch (error) {
            fastify.log.error('Failed to refresh tokens:', error);
        }
    });
    
    // Add hooks to refresh both config and tokens periodically
    fastify.addHook('onReady', async () => {
        // Refresh config every hour
        setInterval(async () => {
            try {
                const updatedConfig = await getNetworkConfig();
                fastify.networkConfig = updatedConfig;
                fastify.log.info('Network config refreshed successfully');
            } catch (error) {
                fastify.log.error('Failed to refresh network config:', error);
            }
        }, 60 * 60 * 1000); // 1 hour
        
        // Refresh tokens every 5 minutes
        setInterval(async () => {
            await fastify.refreshTokens();
        }, 5 * 60 * 1000); // 5 minutes
    });
    
    // Add hook to refresh tokens after modifications
    fastify.addHook('onResponse', async (request) => {
        // Check if the request was a token modification
        if (request.url.startsWith('/tokens') && 
            ['POST', 'PUT', 'DELETE'].includes(request.method)) {
            await fastify.refreshTokens();
        }
    });
}, {
    name: 'network-config-and-tokens'
});