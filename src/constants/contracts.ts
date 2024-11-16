import { GCP_BUCKET_BASE_URL } from "./environment";

/**
 * These are the demo token contracts used for testing purposes in Scroll Sepolia
 */
export const SIMPLE_SWAP_ADDRESS = '0x6dCb40cb50B4E1e7093d036bC1770b12916D3574';
export const defaultNftImage = `${GCP_BUCKET_BASE_URL}/images/default_nft.png`;

export const networkChainIds = {
    ethereum: 1,
    ethereumSepolia: 11155111,
    arbitrum: 42161,
    arbitrumSepolia: 421614,
    scroll: 534352,
    polygon: 137,
    scrollSepoliaTestnet: 534351,
    default: 137,
};