import querystring from 'querystring';
import { FastifyError, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../../helpers/loggerHelper';

// Extend FastifyRequest to include rawBody for webhook verification
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
}

/**
 * Parses the request body based on its format (JSON, URL-encoded, or key-value pair).
 *
 * @param {string} bodyFormatted - The raw body of the request
 * @returns {any} The parsed body
 * @throws {Error} If the body format is unrecognized
 */
function parseBody(body: string): unknown {
  const bodyFormatted = body.trim();

  if (bodyFormatted.startsWith('{') || bodyFormatted.startsWith('[')) {
    try {
      return JSON.parse(bodyFormatted);
    } catch (error) {
      Logger.warn('parseBody', 'JSON parse failed, attempting to fix malformed JSON');
      const fixedBody: string = bodyFormatted.replace(/'/g, '"').replace(/(\w+):/g, '"$1":');
      return JSON.parse(fixedBody);
    }
  } else if (bodyFormatted.includes('=')) {
    Logger.log('parseBody', 'Parsing URL-encoded or key-value data');
    if (!bodyFormatted.includes('&')) {
      const [key, value]: string[] = bodyFormatted.split('=');
      return { [key]: value };
    }
    return querystring.parse(bodyFormatted);
  }

  throw new Error('Unrecognized data format');
}

/**
 * Sets up the custom body parser middleware for the Fastify server.
 *
 * @param {FastifyInstance} server - The Fastify server instance
 */
export async function setupBodyParserMiddleware(server: FastifyInstance): Promise<void> {
  // Raw body parser for webhook signature verification
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (
      req: FastifyRequest,
      body: string,
      done: (err: FastifyError | null, body?: unknown) => void
    ) => {
      try {
        // Store raw body for webhook signature verification
        req.rawBody = body;
        
        // For webhook routes, we might want to keep the raw body
        if (req.url?.startsWith('/webhooks/')) {
          Logger.debug('parseBody', 'Preserving raw body for webhook verification');
          done(null, JSON.parse(body));
          return;
        }

        const parsedBody = parseBody(body);
        Logger.log('parseBody', 'Successfully parsed JSON body');
        done(null, parsedBody);
      } catch (error: unknown) {
        Logger.error('parseBody', 'Failed to parse JSON body');
        const messageError = error instanceof Error ? error.message : 'Unknown error';
        done(
          new Error(`parseBody: Invalid JSON format, error: ${messageError}`) as FastifyError,
          undefined
        );
      }
    }
  );

  // Other content types
  server.addContentTypeParser(
    ['application/x-www-form-urlencoded', 'text/plain'],
    { parseAs: 'string' },
    (
      req: FastifyRequest,
      body: string,
      done: (err: FastifyError | null, body?: unknown) => void
    ) => {
      try {
        req.rawBody = body;
        const parsedBody = parseBody(body);
        Logger.log('parseBody', 'Successfully parsed body');
        done(null, parsedBody);
      } catch (error: unknown) {
        Logger.error('parseBody', 'Failed to parse body');
        const messageError = error instanceof Error ? error.message : 'Unknown error';
        done(
          new Error(`parseBody: Invalid body format, error: ${messageError}`) as FastifyError,
          undefined
        );
      }
    }
  );
}
