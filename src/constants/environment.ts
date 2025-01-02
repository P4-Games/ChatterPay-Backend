import dotenv from 'dotenv';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { LogLevel, validLogLevels } from '../types/logger';

dotenv.config();

const {
  BUN_ENV = 'development',
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
  CHATIZALO_TOKEN,
  PUSH_CHANNEL_ADDRESS: pushChannelAddress = '',
  PUSH_CHANNEL_PRIVATE_KEY: pushChannelPrivateKey = '',
  PUSH_NETWORK: pushNetwork = '11155111',
  PUSH_ENVIRONMENT: pushEnvironment = ENV.DEV,
  MINOR_LOG_LEVEL: minorLogLevel = 'debug'
} = process.env;

export {
  BUN_ENV,
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
export const MONGO_URI: string = envMongoUri ?? 'mongodb://localhost:27017/chatterpay';

export const GCP_ABIs = {
  ChatterPay: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPay.json`,
  ChatterPayWallet: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPayWallet.json`,
  ChatterPayWalletFactory: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPayWalletFactory.json`,
  ChatterPayNFT: `${GCP_BUCKET_BASE_URL}/ABIs/ChatterPayNFT.json`,
  EntryPoint: `${GCP_BUCKET_BASE_URL}/ABIs/EntryPoint.json`,
  ERC20: `${GCP_BUCKET_BASE_URL}/ABIs/ERC20.json`
};

export const NFT_UPLOAD_IMAGE_ICP = envNftUploadImageIcp === 'true' || true;
export const NFT_UPLOAD_IMAGE_IPFS = envNftUploadImageIpfs === 'true' || true;

export const PUSH_CHANNEL_ADDRESS = !pushChannelAddress.startsWith('0x')
  ? `0x${pushChannelAddress}`
  : pushChannelAddress;
export const PUSH_CHANNEL_PRIVATE_KEY = !pushChannelPrivateKey.startsWith('0x')
  ? `0x${pushChannelPrivateKey}`
  : pushChannelPrivateKey;
export const PUSH_NETWORK: string = pushNetwork;
export const PUSH_ENVIRONMENT: ENV = (pushEnvironment.toLowerCase() as ENV) || ENV.DEV;
export const CHATTERPAY_DOMAIN: string = `https://${BUN_ENV === 'development' ? 'dev.' : ''}chatterpay.net`;
export const CHATTERPAY_NFTS_SHARE_URL: string = `${CHATTERPAY_DOMAIN}/nfts/share`;
export const CURRENT_LOG_LEVEL: LogLevel = validLogLevels.includes(
  minorLogLevel.toLowerCase() as LogLevel
)
  ? (minorLogLevel.toLowerCase() as LogLevel)
  : 'error';

export const validLanguages: Array<"en" | "es" | "pt"> = ["en", "es", "pt"];
export const SETTINGS_NOTIFICATION_LANGUAGE_DFAULT: string = 'en';
