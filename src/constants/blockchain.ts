import { GCP_BUCKET_BASE_URL } from './environment';

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
