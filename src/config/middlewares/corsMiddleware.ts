import cors from '@fastify/cors';
import { FastifyInstance } from 'fastify';

import { CORS_ORIGINS } from '../constants';

const corsAllowedDomains = (CORS_ORIGINS || '').split(',').map((domain) => domain.trim());

/**
 * Middleware to configure CORS for the server.
 * @param server - The Fastify server instance.
 */
export async function setupCorsMiddleware(server: FastifyInstance): Promise<void> {
  await server.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, false); // Reject requests without an origin
        return;
      }

      const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
      if (isLocalhost && corsAllowedDomains.includes('*')) {
        callback(null, true);
        return;
      }

      const regexPatterns = corsAllowedDomains
        .filter((entry) => entry !== '*') // Ignore wildcard for other domains
        .map((entry) => {
          if (entry.includes('*')) {
            // Convert wildcard to regex
            return new RegExp(`^${entry.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
          }
          if (entry.includes(':')) {
            // IPv6 addresses don't require further transformation
            return new RegExp(`^${entry}$`);
          }
          // Match exact domain or IP
          return new RegExp(`^${entry}$`);
        });

      const isAllowed = regexPatterns.some((regex) => regex.test(origin));

      if (isAllowed) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false); // Reject the request
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'CONNECT', 'TRACE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Cloud-Trace-Context', 'X-Trace-Options'],
    credentials: true
  });
}
