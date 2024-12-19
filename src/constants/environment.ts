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
    GCP_BUCKET_BASE_URL,
    FRONTEND_TOKEN,
    CHATIZALO_TOKEN
} = process.env;

export {
    PINATA_JWT,
    PRIVATE_KEY,
    SIGNING_KEY,
    BOT_API_URL,
    ICP_MNEMONIC,
    INFURA_API_KEY,
    BOT_DATA_TOKEN,
    FRONTEND_TOKEN,
    ICP_CANISTER_ID,
    CHATIZALO_TOKEN,
    GCP_BUCKET_BASE_URL
};

export const PORT = Number(envPort) || 3000;
export const MONGO_URI = envMongoUri ?? 'mongodb://localhost:27017/chatterpay';

export const GCP_ABIs = {
    ChatterPayWallet: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPayWallet.json`,
    ChatterPayWalletFactory: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPayWalletFactory.json`,
    ChatterPayNFT: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPayNFT.json`,
    EntryPoint: `${GCP_BUCKET_BASE_URL}/ABIs/EntryPoint.json`,
    ERC20: `${GCP_BUCKET_BASE_URL}/ABIs/ERC20.json`,
};

export const NFT_UPLOAD_IMAGE_ICP = envNftUploadImageIcp === 'true' || true;
export const NFT_UPLOAD_IMAGE_IPFS = envNftUploadImageIpfs === 'true' || true;
