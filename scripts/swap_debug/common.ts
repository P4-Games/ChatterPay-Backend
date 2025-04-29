// common.ts
import { URL } from 'url';

import { Logger } from '../../src/helpers/loggerHelper';

export function resolveRpcUrl(): string {
  const { RPC_URL, INFURA_API_KEY } = process.env;

  if (!RPC_URL && !INFURA_API_KEY) {
    Logger.error('resolveRpcUrl', 'ERROR: RPC_URL and INFURA_API_KEY both missing from .env');
    throw new Error('RPC_URL and INFURA_API_KEY missing');
  }

  try {
    if (!RPC_URL) {
      return `https://arbitrum-sepolia.infura.io/v3/${INFURA_API_KEY}`;
    }

    const parsed = new URL(RPC_URL);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);

    const lastSegment = pathSegments.at(-1) || '';
    const hasValidProjectId =
      lastSegment.length >= 10 && !lastSegment.includes('.') && !lastSegment.includes('/');

    const isV2OrV3 = parsed.pathname.startsWith('/v2/') || parsed.pathname.startsWith('/v3/');
    const isCompleteUrl = isV2OrV3 && hasValidProjectId && pathSegments.length === 2;

    if (isCompleteUrl) {
      return RPC_URL;
    }

    if (!INFURA_API_KEY) {
      Logger.error('resolveRpcUrl', 'ERROR: INFURA_API_KEY required to complete partial RPC_URL');
      throw new Error('INFURA_API_KEY missing to complete partial RPC_URL');
    }

    return `${RPC_URL}${INFURA_API_KEY}`;
  } catch (err) {
    Logger.error('resolveRpcUrl', `ERROR: Invalid RPC_URL format: ${(err as Error).message}`);
    throw new Error('Invalid RPC_URL format');
  }
}
