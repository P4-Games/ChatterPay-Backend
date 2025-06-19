import axios from 'axios';
import { FastifyReply, FastifyRequest } from 'fastify';

import { CacheNames } from '../../types/commonType';
import { cacheService } from '../../services/cache/cacheService';
import { returnErrorResponse } from '../../helpers/requestHelper';

/**
 * Retrieves the list of Tor exit node IPs from the Tor Project's exit-addresses service.
 * The result is cached for performance.
 *
 * @returns {Promise<string[]>} - A promise that resolves to an array of Tor exit node IPs.
 */
async function getTorExitIPs(): Promise<string[]> {
  // Check if Tor exit IPs are already cached

  const cachedIPs = cacheService.get<string[]>(CacheNames.TOR, 'torExitIPs');

  if (cachedIPs) {
    return cachedIPs;
  }

  // If not in cache, fetch the exit IPs from the Tor Project
  try {
    const response = await axios.get('https://check.torproject.org/exit-addresses');
    const exitIps = response.data
      .split('\n')
      .filter((line: string) => line.startsWith('ExitAddress'))
      .map((line: string) => line.split(' ')[1]);

    // Cache the exit IPs for subsequent requests
    cacheService.set<string[]>(CacheNames.TOR, 'torExitIPs', exitIps);
    return exitIps;
  } catch (error) {
    console.error('Error fetching Tor exit IPs', error);
    return [];
  }
}

/**
 * Middleware function to block requests coming from Tor exit nodes.
 * It checks the IP of the request against a list of Tor exit node IPs.
 *
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<void>} - A promise that resolves when the check is complete.
 */
export async function torMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Get the client's IP address, considering proxies via 'x-forwarded-for' header
  const clientIp: string =
    request.headers['x-forwarded-for']?.toString().split(',')[0].trim() || request.ip;

  // Retrieve the list of Tor exit IPs (using cache if available)
  const torExitIPs = await getTorExitIPs();

  // Check if the request's IP is one of the Tor exit IPs
  if (torExitIPs.includes(clientIp)) {
    // Reject requests from Tor nodes with a 403 Forbidden response
    returnErrorResponse(reply, 403, `Access forbidden by CORS. Requests from Tor are not allowed.`);
  }
}
