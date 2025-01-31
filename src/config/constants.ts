import dotenv from 'dotenv';
import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { LogLevel, validLogLevels } from '../types/loggerType';

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
  GCP_CLOUD_TRACE_ENABLED: gcpCloudTraceEnabled = 'false',
  PUSH_NETWORK: pushNetwork = '11155111',
  PUSH_ENVIRONMENT: pushEnvironment = ENV.DEV,
  MINOR_LOG_LEVEL: minorLogLevel = 'debug',
  MANTECA_BASE_URL = 'https://api.manteca.dev/crypto/v1',
  MANTECA_API_KEY,
  CORS_ORIGINS = '*',
  BLACKLIST_IPS = '',
  DEFAULT_CHAIN_ID: defaultChainId = 421614, // Arbitrum Sepolia
  FASTIFY_REFRESH_NETWORKS_INTERVAL_MS: fastifyRefreshNetworksIntervalMs = 86400000,
  FASTIFY_REFRESH_TOKENS_INTERVAL_MS: fastifyRefreshTokensIntervalMs = 86400000,
  ABIS_VERSION = 'v1.0.0',
  CORS_ORIGINS_CHECK_POSTMAN: corsOriginsCheckPostman = 'false'
} = process.env;

export {
  BUN_ENV,
  PINATA_JWT,
  PRIVATE_KEY,
  SIGNING_KEY,
  BOT_API_URL,
  ICP_MNEMONIC,
  CORS_ORIGINS,
  ABIS_VERSION,
  BLACKLIST_IPS,
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
export const DEFAULT_CHAIN_ID = Number(defaultChainId);

export const GCP_ABIs = {
  ChatterPay: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPay.json`,
  ChatterPayWallet: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayWallet.json`,
  ChatterPayWalletFactory: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayWalletFactory.json`,
  ChatterPayNFT: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayNFT.json`,
  EntryPoint: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/EntryPoint.json`,
  ERC20: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ERC20.json`
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
export const CURRENT_LOG_LEVEL: LogLevel = validLogLevels.includes(
  minorLogLevel.toLowerCase() as LogLevel
)
  ? (minorLogLevel.toLowerCase() as LogLevel)
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

export const LIFI_SLIPPAGE = 30 / 1000;
export const LIFI_TYPE = 'SAFEST';

export const NOTIFICATION_TEMPLATE_CACHE_TTL = 60800; // 1 week
export const RESET_USER_OPERATION_THRESHOLD_MINUTES = 30;
export const GCP_CLOUD_TRACE_ENABLED: boolean = gcpCloudTraceEnabled.toLowerCase() === 'true';

export const QUEUE_BUNDLER_INTERVAL = 10000; // 10 Seg
export const QUEUE_GAS_INTERVAL = 10000; // 10 Seg

export const FASTIFY_REFRESH_TOKENS_INTERVAL_MS: number = Number(fastifyRefreshNetworksIntervalMs);
export const FASTIFY_REFRESH_NETWORKS_INTERVAL_MS: number = Number(fastifyRefreshTokensIntervalMs);

export const WHATSAPP_API_URL = 'https://api.whatsapp.com';
export const CHATIZALO_PHONE_NUMBER = IS_DEVELOPMENT ? 5491168690963 : 5491164629653;

export const MANTECA_MOCK_UPLOAD_DOCUMENTS_URL = 'https://upload.manteca.dev/file-upload-url';
export const INFURA_URL = 'https://mainnet.infura.io/v3';
export const BINANCE_API_URL = 'https://api.binance.us/api/v3';
export const GRAPH_API_USDT_URL =
  'https://api.studio.thegraph.com/query/91286/balance-sepolia/version/latest';
export const GRAPH_API_WETH_URL =
  'https://api.studio.thegraph.com/query/91286/balance-sepolia-weth/version/latest';

export const CRIPTO_YA_URL: string = 'https://criptoya.com/api/ripio/USDT';
export const FIAT_CURRENCIES = ['UYU', 'ARS', 'BRL'];

export const ICP_URL = 'https://ic0.app';
export const PINATA_IPFS_URL = 'https://gateway.pinata.cloud/ipfs';

export const COMMON_REPLY_OPERATION_IN_PROGRESS =
  'The operation is being processed. We will notify you once it is completed or if any issues arise.';
export const CORS_ORIGINS_CHECK_POSTMAN: boolean = corsOriginsCheckPostman.toLowerCase() === 'true';