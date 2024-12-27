import querystring from 'querystring';
import { FastifyError, FastifyRequest, FastifyInstance } from 'fastify';

/**
 * Parses the request body based on its format (JSON, URL-encoded, or key-value pair).
 *
 * @param {string} body - The raw body of the request
 * @returns {any} The parsed body
 * @throws {Error} If the body format is unrecognized
 */
function parseBody(body: string): unknown {
  body = body.trim();

  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      return JSON.parse(body);
    } catch (error) {
      console.warn('JSON parse failed, attempting to fix malformed JSON');
      const fixedBody: string = body.replace(/'/g, '"').replace(/(\w+):/g, '"$1":');
      return JSON.parse(fixedBody);
    }
  } else if (body.includes('=')) {
    console.log('Parsing URL-encoded or key-value data');
    if (!body.includes('&')) {
      const [key, value]: string[] = body.split('=');
      return { [key]: value };
    }
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
        const parsedBody = parseBody(body);
        console.log('Successfully parsed body:', parsedBody);
        done(null, parsedBody);
      } catch (err) {
        console.error('Failed to parse body:', body);
        done(new Error('Invalid body format') as FastifyError, undefined);
      }
    }
  );
}
