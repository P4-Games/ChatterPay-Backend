import querystring from 'querystring';
import { FastifyError, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../utils/logger';

/**
 * Parses the request body based on its format (JSON, URL-encoded, or key-value pair).
 *
 * @param {string} body - The raw body of the request
 * @returns {any} The parsed body
 * @throws {Error} If the body format is unrecognized
 */
function parseBody(body: string): unknown {
  console.info('xxxxxxxxxxxx-BODY-2', body)
  body = body.trim();
  console.info('xxxxxxxxxxxx-BODY-3')

  if (body.startsWith('{') || body.startsWith('[')) {
    console.info('xxxxxxxxxxxx-BODY-4')
    try {
      console.info('xxxxxxxxxxxx-BODY-5')
      return JSON.parse(body);
    } catch (error) {
      console.error('xxxxxxxxxxxx-BODY-6', error)
      Logger.warn('JSON parse failed, attempting to fix malformed JSON');
      const fixedBody: string = body.replace(/'/g, '"').replace(/(\w+):/g, '"$1":');
      console.error('xxxxxxxxxxxx-BODY-7', fixedBody)
      return JSON.parse(fixedBody);
    }
  } else if (body.includes('=')) {
    console.error('xxxxxxxxxxxx-BODY-8')
    Logger.log('Parsing URL-encoded or key-value data');
    if (!body.includes('&')) {
      console.error('xxxxxxxxxxxx-BODY-9')
      const [key, value]: string[] = body.split('=');
      console.error('xxxxxxxxxxxx-BODY-10', value)
      return { [key]: value };
    }
    console.error('xxxxxxxxxxxx-BODY-11')
    return querystring.parse(body);
  }

  throw new Error('Unrecognized data format');
}

/**
 * Sets up the custom body parser middleware for the Fastify server.
 *
 * @param {FastifyInstance} server - The Fastify server instance
 */
export async function setupMiddleware(server: FastifyInstance): Promise<void> {
  server.addContentTypeParser(
    ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
    { parseAs: 'string' },
    (
      req: FastifyRequest,
      body: string,
      done: (err: FastifyError | null, body?: unknown) => void
    ) => {
      try {
        console.info('xxxxxxxxxxxx-BODY-00', body)
        const parsedBody = parseBody(body);
        console.info('xxxxxxxxxxxx-BODY-01', parsedBody)
        // Logger.log('Successfully parsed body:', parsedBody);
        Logger.log('Successfully parsed body:', body);
        done(null, parsedBody);
      } catch (error: unknown) {
        Logger.error('Failed to parse body:', body);
        const messageError = error instanceof Error ? error.message : 'Unknown error'
        console.error('xxxxxxxxxxxx-BODY-01', messageError)
        done(new Error(`Invalid body format, error: ${messageError}`) as FastifyError, undefined);
      }
    }
  );
}
