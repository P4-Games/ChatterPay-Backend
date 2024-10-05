import dotenv from 'dotenv';

dotenv.config();

const {
    PORT: envPort,
    MONGO_URI: envMongoUri,
    PRIVATE_KEY,
    SIGNING_KEY,
    PINATA_JWT,
    ICP_CANISTER_ID,
    ICP_MNEMONIC,
    INFURA_API_KEY,
    BOT_DATA_TOKEN,
    BOT_API_URL,
    NFT_UPLOAD_IMAGE_ICP: envNftUploadImageIcp,
    NFT_UPLOAD_IMAGE_IPFS: envNftUploadImageIpfs,
} = process.env;

export {
    PINATA_JWT,
    PRIVATE_KEY,
    SIGNING_KEY,
    BOT_API_URL,
    ICP_MNEMONIC,
    INFURA_API_KEY,
    BOT_DATA_TOKEN,
    ICP_CANISTER_ID,
};

export const PORT = Number(envPort) || 3000;
export const MONGO_URI = envMongoUri ?? 'mongodb://localhost:27017/chatterpay';
export const NFT_UPLOAD_IMAGE_ICP = envNftUploadImageIcp === 'true' ?? true;
export const NFT_UPLOAD_IMAGE_IPFS = envNftUploadImageIpfs === 'true' ?? true;
export const GCP_ABIs = {
  ChatterPayWallet:"https://storage.googleapis.com/chatbot-multimedia/chatterpay/ABIs/ChatterPayWallet.json",
  ChatterPayWalletFactory: "https://storage.googleapis.com/chatbot-multimedia/chatterpay/ABIs/ChatterPayWalletFactory.json",
  ChatterPayNFT: "https://storage.googleapis.com/chatbot-multimedia/chatterpay/ABIs/ChatterPayNFT.json",
  EntryPoint: "https://storage.googleapis.com/chatbot-multimedia/chatterpay/ABIs/EntryPoint.json",
  ERC20: "https://storage.googleapis.com/chatbot-multimedia/chatterpay/ABIs/ERC20.json",
}
export const NFT_UPLOAD_IMAGE_ICP = (envNftUploadImageIcp === 'true') || true;
export const NFT_UPLOAD_IMAGE_IPFS =  (envNftUploadImageIpfs === 'true') || true;
