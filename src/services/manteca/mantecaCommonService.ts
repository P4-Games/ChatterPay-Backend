import { MANTECA_API_KEY } from '../../config/constants';

/**
 * Helper function to get Axios configuration with common headers.
 *
 * @returns The common headers to be used in all requests.
 */
export const getMantecaAxiosConfig = () => ({
  headers: {
    'md-api-key': MANTECA_API_KEY,
    'Content-Type': 'application/json'
  }
});
