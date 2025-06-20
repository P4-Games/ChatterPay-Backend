import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import { LogLevel, validLogLevels } from '../types/loggerType';
import { NotificationLanguage, notificationLanguages } from '../types/commonType';

const {
  BUN_ENV = 'localhost',
  PORT: envPort,
  MONGO_URI: envMongoUri,
  SEED_INTERNAL_SALT,
  SIGNING_KEY,
  PINATA_JWT,
  ICP_CANISTER_ID,
  ICP_MNEMONIC,
  INFURA_API_KEY,
  BOT_DATA_TOKEN,
  BOT_API_URL,
  BOT_NOTIFICATIONS_ENABLED: botNotificationsEnabled = 'true',
  NFT_UPLOAD_IMAGE_ICP: envNftUploadImageIcp = 'false',
  NFT_UPLOAD_IMAGE_IPFS: envNftUploadImageIpfs = 'false',
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
  MANTECA_BASE_URL = 'https://sandbox.manteca.dev/crypto/v1',
  MANTECA_API_KEY,
  CORS_ORIGINS = '*',
  BLACKLIST_IPS = '',
  DEFAULT_CHAIN_ID: defaultChainId = 421614, // Arbitrum Sepolia
  FASTIFY_REFRESH_NETWORKS_INTERVAL_MS: fastifyRefreshNetworksIntervalMs = 86400000,
  FASTIFY_REFRESH_TOKENS_INTERVAL_MS: fastifyRefreshTokensIntervalMs = 86400000,
  ABIS_VERSION = 'v1.0.0',
  CORS_ORIGINS_CHECK_POSTMAN: corsOriginsCheckPostman = 'false',
  SWAP_SLIPPAGE_CONFIG_STABLE: slippage_config_stable = 300,
  SWAP_SLIPPAGE_CONFIG_DEFAULT: slippage_config_default = 500,
  SWAP_SLIPPAGE_CONFIG_EXTRA: slippage_config_extra = 300,
  ABIS_READ_FROM: abisReadFrom = 'local',
  CHATIZALO_PHONE_NUMBER,
  QUEUE_BUNDLER_INTERVAL: queueBundlerInterval = 150,
  QUEUE_GAS_INTERVAL: queueGasInterval = 250,
  QUEUE_CREATE_PROXY_INTERVAL: queueCreateProxyInterval = 150,
  ISSUER_TOKENS_ENABLED: issuerTokensEnabled = 'false',
  MAX_REQUESTS_PER_MINUTE: maxRequestsPerMinute = 50
} = process.env;

export {
  BUN_ENV,
  PINATA_JWT,
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
  SEED_INTERNAL_SALT,
  GCP_BUCKET_BASE_URL,
  CHATIZALO_PHONE_NUMBER
};

export const IS_DEVELOPMENT =
  BUN_ENV.toLowerCase() === 'development' || BUN_ENV.toLowerCase() === 'testing';
export const PORT = Number(envPort) || 3000;
export const MONGO_URI: string = envMongoUri ?? 'mongodb://localhost:27017/chatterpay';
export const DEFAULT_CHAIN_ID = Number(defaultChainId);

interface ABIs {
  [key: string]: string;
}

export const GCP_ABIs: ABIs = {
  ChatterPay: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPay.sol/ChatterPay.json`,
  ChatterPayWalletProxy: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayWalletProxy.sol/ChatterPayWalletProxy.json`,
  ChatterPayWalletFactory: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayWalletFactory.sol/ChatterPayWalletFactory.json`,
  ChatterPayNFT: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayNFT.sol/ChatterPayNFT.json`,
  EntryPoint: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/EntryPoint.sol/EntryPoint.json`,
  ERC20: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ERC20.sol/ERC20.json`,
  ChainlinkPriceFeed: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChainlinkPriceFeed.sol/ChainlinkPriceFeed.json`
};

export const LOCAL_ABIs: ABIs = {
  ChatterPay: `ChatterPay.sol/ChatterPay.json`,
  ChatterPayWalletProxy: `ChatterPayWalletProxy.sol/ChatterPayWalletProxy.json`,
  ChatterPayWalletFactory: `ChatterPayWalletFactory.sol/ChatterPayWalletFactory.json`,
  ChatterPayNFT: `ChatterPayNFT.sol/ChatterPayNFT.json`,
  EntryPoint: `EntryPoint.sol/EntryPoint.json`,
  ERC20: `ERC20.sol/ERC20.json`,
  ChainlinkPriceFeed: `ChainlinkPriceFeed.sol/ChainlinkPriceFeed.json`
};

export const ABIS_READ_FROM = abisReadFrom.toLowerCase();
export const NFT_UPLOAD_IMAGE_ICP: boolean = envNftUploadImageIcp.toLowerCase() === 'true';
export const NFT_UPLOAD_IMAGE_IPFS: boolean = envNftUploadImageIpfs.toLowerCase() === 'true';
export const defaultNftImage = `${GCP_BUCKET_BASE_URL}/images/default_nft.png`;

export const PUSH_CHANNEL_ADDRESS = !pushChannelAddress.startsWith('0x')
  ? `0x${pushChannelAddress}`
  : pushChannelAddress;
export const PUSH_CHANNEL_PRIVATE_KEY = !pushChannelPrivateKey.startsWith('0x')
  ? `0x${pushChannelPrivateKey}`
  : pushChannelPrivateKey;
export const PUSH_ENABLED: boolean = pushEnabled.toLowerCase() === 'true';
export const ISSUER_TOKENS_ENABLED: boolean = issuerTokensEnabled.toLowerCase() === 'true';

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

export const validLanguages: NotificationLanguage[] = [...notificationLanguages];
export const SETTINGS_NOTIFICATION_LANGUAGE_DEFAULT: NotificationLanguage = 'en';

export const RESET_USER_OPERATION_THRESHOLD_MINUTES = 30;
export const GCP_CLOUD_TRACE_ENABLED: boolean = gcpCloudTraceEnabled.toLowerCase() === 'true';

export const FASTIFY_REFRESH_TOKENS_INTERVAL_MS: number = Number(fastifyRefreshNetworksIntervalMs);
export const FASTIFY_REFRESH_NETWORKS_INTERVAL_MS: number = Number(fastifyRefreshTokensIntervalMs);

export const WHATSAPP_API_URL = 'https://api.whatsapp.com';

export const MANTECA_MOCK_UPLOAD_DOCUMENTS_URL = 'https://upload.manteca.dev/file-upload-url';
export const INFURA_URL = 'https://mainnet.infura.io/v3';
export const BINANCE_API_URL = 'https://api.binance.us/api/v3';
export const GRAPH_API_EXTERNAL_DEPOSITS_URL =
  'https://api.studio.thegraph.com/query/91286/chatterpay-external-deposits/version/latest';

export const CRIPTO_YA_URL: string = 'https://criptoya.com/api/ripio/USDT';
export const FIAT_CURRENCIES = ['UYU', 'ARS', 'BRL'];

export const ICP_URL = 'https://ic0.app';
export const PINATA_IPFS_URL = 'https://gateway.pinata.cloud/ipfs';

export const COMMON_REPLY_OPERATION_IN_PROGRESS =
  'The operation is being processed. We will notify you once it is completed or if any issues arise.';

export const COMMON_REPLY_WALLET_NOT_CREATED = `A wallet linked to your phone number hasn't been created yet. Please create one to continue with the operation.`;

export const CORS_ORIGINS_CHECK_POSTMAN: boolean = corsOriginsCheckPostman.toLowerCase() === 'true';
export const CORS_ORIGINS_EXCEPTIONS: string = '/metadata/opensea,/favicon.ico,/docs';

export const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3/simple/price';
export const TOKEN_IDS = ['usd-coin', 'tether', 'ethereum', 'bitcoin', 'wrapped-bitcoin', 'dai'];
export const RESULT_CURRENCIES = ['usd', 'ars', 'brl', 'uyu'];

export const SWAP_SLIPPAGE_CONFIG_STABLE = Number(slippage_config_stable);
export const SWAP_SLIPPAGE_CONFIG_DEFAULT = Number(slippage_config_default);
export const SWAP_SLIPPAGE_CONFIG_EXTRA = Number(slippage_config_extra);

export const QUEUE_BUNDLER_INTERVAL = Number(queueBundlerInterval);
export const QUEUE_GAS_INTERVAL = Number(queueGasInterval);
export const QUEUE_CREATE_PROXY_INTERVAL = Number(queueCreateProxyInterval);
export const MAX_REQUESTS_PER_MINUTE = Number(maxRequestsPerMinute);

export const CACHE_OPENSEA_TTL = 300; // 5 min
export const CACHE_OPENSEA_CHECK_PERIOD = 600; // 10 min

export const CACHE_PRICE_TTL = 300; // 5 min
export const CACHE_PRICE_CHECK_PERIOD = 360; // 6 min

export const CACHE_ABI_TTL = 432000; // 5 days
export const CACHE_ABI_CHECK_PERIOD = 518400; // 6 days

export const CACHE_NOTIFICATION_TTL = 432000; // 5 days
export const CACHE_NOTIFICATION_CHECK_PERIOD = 518400; // 6 days

export const CACHE_TOR_TTL = 3600; // 1 hora
export const CACHE_TOR_CHECK_PERIOD = 3700; // 62 min

export const CACHE_COINGECKO_TTL = 60; // 1 min
export const CACHE_COINGECKO_CHECK_PERIOD = 120; // 2 min
