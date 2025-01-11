import dotenv from 'dotenv';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { LogLevelType, validLogLevels } from '../types/logger';

dotenv.config();

const {
  BUN_ENV = 'localhost',
  PORT: envPort,
  MONGO_URI: envMongoUri,
  PRIVATE_KEY,
  SIGNING_KEY,
  PINATA_JWT,
  ICP_CANISTER_ID,
  ICP_MNEMONIC,
  INFURA_API_KEY,
  MAX_FEE_PER_GAS: maxFeeperGas = '30',
  MAX_PRIORITY_FEE_PER_GAS: maxPriorityFeePerGas = '5',
  VERIFICATION_GAS_LIMIT: verificationGasLimit = 74908,
  CALL_GAS_LIMIT: callGasLimit = 79728,
  PRE_VERIFICATION_GAS: preVerificationGas = 500000,
  BOT_DATA_TOKEN,
  BOT_API_URL,
  BOT_NOTIFICATIONS_ENABLED: botNotificationsEnabled = 'true',
  NFT_UPLOAD_IMAGE_ICP: envNftUploadImageIcp,
  NFT_UPLOAD_IMAGE_IPFS: envNftUploadImageIpfs,
  GCP_BUCKET_BASE_URL,
  FRONTEND_TOKEN,
  CHATIZALO_TOKEN,
  PUSH_CHANNEL_ADDRESS: pushChannelAddress = '',
  PUSH_CHANNEL_PRIVATE_KEY: pushChannelPrivateKey = '',
  PUSH_ENABLED: pushEnabled = 'false',
  PUSH_NETWORK: pushNetwork = '11155111',
  PUSH_ENVIRONMENT: pushEnvironment = ENV.DEV,
  MINOR_LOG_LEVEL: minorLogLevel = 'debug',
  MANTECA_BASE_URL = 'https://api.manteca.dev/crypto/v1',
  MANTECA_API_KEY
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
  MANTECA_API_KEY,
  MANTECA_BASE_URL,
  GCP_BUCKET_BASE_URL
};

export const IS_DEVELOPMENT = BUN_ENV.toLowerCase() === 'development';
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
export const defaultNftImage = `${GCP_BUCKET_BASE_URL}/images/default_nft.png`;

export const PUSH_CHANNEL_ADDRESS = !pushChannelAddress.startsWith('0x')
  ? `0x${pushChannelAddress}`
  : pushChannelAddress;
export const PUSH_CHANNEL_PRIVATE_KEY = !pushChannelPrivateKey.startsWith('0x')
  ? `0x${pushChannelPrivateKey}`
  : pushChannelPrivateKey;
export const PUSH_ENABLED: boolean = pushEnabled.toLowerCase() === 'true';
export const BOT_NOTIFICATIONS_ENABLED: boolean = botNotificationsEnabled.toLowerCase() === 'true';
export const PUSH_NETWORK: string = pushNetwork;
export const PUSH_ENVIRONMENT: ENV = (pushEnvironment.toLowerCase() as ENV) || ENV.DEV;
export const CHATTERPAY_DOMAIN: string = `https://${IS_DEVELOPMENT ? 'dev.' : ''}chatterpay.net`;
export const CHATTERPAY_NFTS_SHARE_URL: string = `${CHATTERPAY_DOMAIN}/nfts/share`;
export const CURRENT_LOG_LEVEL: LogLevelType = validLogLevels.includes(
  minorLogLevel.toLowerCase() as LogLevelType
)
  ? (minorLogLevel.toLowerCase() as LogLevelType)
  : 'error';

export const validLanguages: Array<'en' | 'es' | 'pt'> = ['en', 'es', 'pt'];
export const SETTINGS_NOTIFICATION_LANGUAGE_DFAULT: string = 'en';

export const MAX_FEE_PER_GAS: string = maxFeeperGas;
export const MAX_PRIORITY_FEE_PER_GAS: string = maxPriorityFeePerGas;
export const VERIFICATION_GAS_LIMIT: number = Number(verificationGasLimit);
export const CALL_GAS_LIMIT: number = Number(callGasLimit);
export const PRE_VERIFICATION_GAS: number = Number(preVerificationGas);

export const PAYMASTER_MIN_BALANCE: string = '0.15';
export const PAYMASTER_TARGET_BALANCE: string = '0.3';
export const BACKEND_SIGNER_MIN_BALANCE: string = '0.5'; // must have at least: PAYMASTER_TARGET_BALANCE + 0.005
export const USER_SIGNER_MIN_BALANCE: string = '0.0008';
export const USER_SIGNER_BALANCE_TO_TRANSFER: string = '0.001';

export const DEFAULT_CHAIN_ID = 421614; // Arbitrum Sepolia
export const LIFI_SLIPPAGE = 30 / 1000;
export const LIFI_TYPE = 'SAFEST';
