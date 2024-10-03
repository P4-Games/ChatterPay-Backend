/**
 * These are the demo token contracts used for testing purposes in Scroll Sepolia
 */

/*
    Scroll Sepolia

    export const WETH_ADDRESS = "0xAb9c2e04398ad9e9369360de77c011516a5aef99";
    export const USDT_ADDRESS = "0xfE2af1D55F7da5eD75f63aF5fD61136e1F92c4f9";
    export const SIMPLE_SWAP_ADDRESS = "0x7c38F638Bb821Cf8E5A8c59460f5C6a992a9cBAE";
*/

/**
 * Arbitrum sepolia
 */

export const WETH_ADDRESS = "0x7BA164d1F23d7bA7F007AfB1fE59A9f3967F1Cde";
export const USDT_ADDRESS = "0xB983f7176fB3d2D87c30943D3d5C80351fE26e2b";
export const SIMPLE_SWAP_ADDRESS = "0x2493CeB3Ae366eF75bfaA1851B80a420F729F048";
export const defaultNftImage =
    'https://storage.googleapis.com/chatbot-multimedia/chatterpay/default/default_nft.png';

export const NFT_UPLOAD_IMAGE_ICP = process.env.NFT_UPLOAD_IMAGE_ICP === 'true' ?? true;
export const NFT_UPLOAD_IMAGE_IPFS = process.env.NFT_UPLOAD_IMAGE_IPFS === 'true' ?? true;
