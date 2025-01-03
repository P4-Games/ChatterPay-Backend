import { GCP_BUCKET_BASE_URL } from './environment';

export const SIMPLE_SWAP_ADDRESS = '0xd1D3ec40941da7d74e07D5Da240be35cd6c2574D';
export const defaultNftImage = `${GCP_BUCKET_BASE_URL}/images/default_nft.png`;

export const networkChainIds = {
  ethereum: 1,
  ethereumSepolia: 11155111,
  arbitrum: 42161,
  arbitrumSepolia: 421614,
  scroll: 534352,
  scrollSepoliaTestnet: 534351,
  default: 421614
};

export const LIFI_SLIPPAGE = 30 / 1000;
export const LIFI_TYPE = 'SAFEST';
