import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';

import { getNetworkConfig } from '../services/networkService';

// Declare the types for our config
declare module 'fastify' {
  interface FastifyInstance {
    networkConfig: {
      contracts: {
        entryPoint: string;
        paymasterAddress?: string;
        // Add other config properties
      };
    };
  }
}

export default fp(async (fastify: FastifyInstance) => {
    // Fetch network config once during server startup
    const networkConfig = await getNetworkConfig();
    
    // Decorate fastify instance with the config
    fastify.decorate('networkConfig', networkConfig);
    
    // Optional: Add a hook to refresh the config periodically
    fastify.addHook('onReady', async () => {
      // Example: Refresh every hour
      setInterval(async () => {
        try {
          const updatedConfig = await getNetworkConfig();
          fastify.networkConfig = updatedConfig;
          fastify.log.info('Network config refreshed successfully');
        } catch (error) {
          fastify.log.error('Failed to refresh network config:', error);
        }
      }, 60 * 60 * 1000); // 1 hour
    });
}, {
  name: 'network-config'
});