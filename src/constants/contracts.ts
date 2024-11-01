import { GCP_BUCKET_BASE_URL } from "./environment";

/**
 * These are the demo token contracts used for testing purposes in Scroll Sepolia
 */
export const SIMPLE_SWAP_ADDRESS = '0x7c38F638Bb821Cf8E5A8c59460f5C6a992a9cBAE';
export const defaultNftImage = `${GCP_BUCKET_BASE_URL}/images/default_nft.png`;

export const networkChainIds = {
    ethereum: 1,
    ethereumSepolia: 11155111,
    arbitrum: 42161,
    arbitrumSepolia: 421614,
    scroll: 534352,
    scrollSepoliaTestnet: 534351,
    default: 421614,
};