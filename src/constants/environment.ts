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
  GCP_PK,
  NFT_UPLOAD_IMAGE_ICP: envNftUploadImageIcp,
  NFT_UPLOAD_IMAGE_IPFS: envNftUploadImageIpfs,
} = process.env;

export { PINATA_JWT, PRIVATE_KEY, SIGNING_KEY, ICP_MNEMONIC, INFURA_API_KEY, ICP_CANISTER_ID };

export const PORT = Number(envPort) || 3000;
export const MONGO_URI = envMongoUri ?? 'mongodb://localhost:27017/chatterpay';
export const NFT_UPLOAD_IMAGE_ICP = envNftUploadImageIcp === 'true' ?? true;
export const NFT_UPLOAD_IMAGE_IPFS = envNftUploadImageIpfs === 'true' ?? true;
export const GCP_PRIVATE_KEY = Buffer.from((GCP_PK ?? ""), "base64").toString().split(String.raw`\n`).join("\n");