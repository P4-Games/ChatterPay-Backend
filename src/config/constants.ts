import { ENV } from '@pushprotocol/restapi/src/lib/constants';

import {
  type gamesLanguage,
  type NotificationLanguage,
  notificationLanguages
} from '../types/commonType';
import { type LogLevel, validLogLevels } from '../types/loggerType';

interface ABIs {
  [key: string]: string;
}

interface CHATTERPOINTS {
  [key: string]: string;
}

const {
  BUN_ENV = 'localhost',
  PORT: envPort,
  MONGO_URI: envMongoUri,
  SEED_INTERNAL_SALT,
  SIGNING_KEY,
  SECURITY_HMAC_KEY,
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
  THE_GRAPH_API_KEY,
  THE_GRAPH_EXTERNAL_DEPOSITS_URL = '',
  CORS_ORIGINS = '*',
  BLACKLIST_IPS = '',
  DEFAULT_CHAIN_ID: defaultChainId = 534351, // Scroll Sepolia
  ALCHEMY_AUTH_TOKEN,
  ALCHEMY_SIGNING_KEY,
  ALCHEMY_VAR_WALLETS_ID,
  ALCHEMY_VAR_WALLETS_TOPIC_ID,
  ALCHEMY_VAR_TOKENS_ID,
  ALCHEMY_WEBHOOK_HEADER_API_KEY,
  ALCHEMY_ERC20_TRANSFER_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ALCHEMY_VALIDATE_WEBHOOK_HEADER_API_KEY: alchemyValidateWebhookHeaderApiKey = 'false',
  EXTERNAL_DEPOSITS_PROVIDER = 'thegraph',
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
  MAX_REQUESTS_PER_MINUTE: maxRequestsPerMinute = 50,
  SWAP_ZERO_FEE_MODE: swapZeroFeeMode = 'false',
  SWAP_EXECUTE_SIMPLE: swapExecuteSimple = 'true',
  SWAP_USE_QUOTER: swapUseQuoter = 'false',
  SWAP_QUOTE_VS_PRICES_FEEDS_THRESHOLD_PERCENT: swapQuoteVsPricesFeedsThresholdPercent = 5,
  CHATTERPOINTS_WORDS_SEED = 'default',
  CHATTERPOINTS_WORDS_READ_FROM: chatterpointsWordsReadFrom = 'local',
  CDS1,
  CDS2,
  CDS3,
  CDO1,
  CDO2,
  CDO3,
  CDO4,
  CDP1,
  CDP2,
  TELEGRAM_BOT_API_KEY,
  SECURITY_PIN_LENGTH: securityPinLength = 6,
  SECURITY_PIN_MAX_FAILED_ATTEMPTS: securityPinMaxFailedAttempts = 3,
  SECURITY_PIN_BLOCK_MINUTES: securityPinBlockMinutes = 60,
  SECURITY_PIN_ENABLED: securityPinEnabled = 'true'
} = process.env;

export {
  CDS1,
  CDS2,
  CDS3,
  CDO1,
  CDO2,
  CDO3,
  CDO4,
  CDP1,
  CDP2,
  PINATA_JWT,
  BOT_API_URL,
  ICP_MNEMONIC,
  CORS_ORIGINS,
  ABIS_VERSION,
  BUN_ENV as $B,
  BLACKLIST_IPS,
  INFURA_API_KEY,
  BOT_DATA_TOKEN,
  FRONTEND_TOKEN,
  ICP_CANISTER_ID,
  CHATIZALO_TOKEN,
  MANTECA_API_KEY,
  MANTECA_BASE_URL,
  THE_GRAPH_API_KEY,
  SECURITY_HMAC_KEY,
  SIGNING_KEY as $P,
  ALCHEMY_AUTH_TOKEN,
  ALCHEMY_SIGNING_KEY,
  GCP_BUCKET_BASE_URL,
  TELEGRAM_BOT_API_KEY,
  ALCHEMY_VAR_TOKENS_ID,
  ALCHEMY_VAR_WALLETS_ID,
  CHATIZALO_PHONE_NUMBER,
  SEED_INTERNAL_SALT as $S,
  CHATTERPOINTS_WORDS_SEED,
  EXTERNAL_DEPOSITS_PROVIDER,
  ALCHEMY_VAR_WALLETS_TOPIC_ID,
  ALCHEMY_WEBHOOK_HEADER_API_KEY,
  THE_GRAPH_EXTERNAL_DEPOSITS_URL,
  ALCHEMY_ERC20_TRANSFER_SIGNATURE
};

export const IS_DEVELOPMENT =
  BUN_ENV.toLowerCase() === 'development' || BUN_ENV.toLowerCase() === 'testing';
export const PORT = Number(envPort) || 3000;
export const MONGO_URI: string = envMongoUri ?? 'mongodb://localhost:27017/chatterpay';
export const DEFAULT_CHAIN_ID = Number(defaultChainId);

export const GCP_ABIs: ABIs = {
  ChatterPay: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPay.sol/ChatterPay.json`,
  ChatterPayWalletProxy: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayWalletProxy.sol/ChatterPayWalletProxy.json`,
  ChatterPayWalletFactory: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayWalletFactory.sol/ChatterPayWalletFactory.json`,
  ChatterPayNFT: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChatterPayNFT.sol/ChatterPayNFT.json`,
  EntryPoint: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/EntryPoint.sol/EntryPoint.json`,
  ERC20: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ERC20.sol/ERC20.json`,
  ChainlinkPriceFeed: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/ChainlinkPriceFeed.sol/ChainlinkPriceFeed.json`,
  UniswapQuoterV2: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/Uniswap.sol/QuoterV2.json`,
  UniswapRouter02: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/Uniswap.sol/Router02.json`,
  Multicall3: `${GCP_BUCKET_BASE_URL}/ABIs/${ABIS_VERSION}/Multicall3.sol/Multicall3.json`
};

export const LOCAL_ABIs: ABIs = {
  ChatterPay: `ChatterPay.sol/ChatterPay.json`,
  ChatterPayWalletProxy: `ChatterPayWalletProxy.sol/ChatterPayWalletProxy.json`,
  ChatterPayWalletFactory: `ChatterPayWalletFactory.sol/ChatterPayWalletFactory.json`,
  ChatterPayNFT: `ChatterPayNFT.sol/ChatterPayNFT.json`,
  EntryPoint: `EntryPoint.sol/EntryPoint.json`,
  ERC20: `ERC20.sol/ERC20.json`,
  ChainlinkPriceFeed: `ChainlinkPriceFeed.sol/ChainlinkPriceFeed.json`,
  UniswapQuoterV2: `Uniswap.sol/QuoterV2.json`,
  UniswapRouter02: `Uniswap.sol/Router02.json`,
  Multicall3: `Multicall3.sol/Multicall3.json`
};

export const GCP_CHATTERPOINTS: CHATTERPOINTS = {
  Words: `${GCP_BUCKET_BASE_URL}/chatterpoints/words.json`
};

export const LOCAL_CHATTERPOINTS: CHATTERPOINTS = {
  Words: `words.json`
};

export const ABIS_READ_FROM = abisReadFrom.toLowerCase();
export const CHATTERPOINTS_WORDS_READ_FROM = chatterpointsWordsReadFrom.toLowerCase();
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

export const GAMES_LANGUAGE_DEFAULT: gamesLanguage = 'en';

export const RESET_USER_OPERATION_THRESHOLD_MINUTES = 30;
export const GCP_CLOUD_TRACE_ENABLED: boolean = gcpCloudTraceEnabled.toLowerCase() === 'true';

export const FASTIFY_REFRESH_TOKENS_INTERVAL_MS: number = Number(fastifyRefreshNetworksIntervalMs);
export const FASTIFY_REFRESH_NETWORKS_INTERVAL_MS: number = Number(fastifyRefreshTokensIntervalMs);

export const WHATSAPP_API_URL = 'https://api.whatsapp.com';

export const MANTECA_MOCK_UPLOAD_DOCUMENTS_URL = 'https://upload.manteca.dev/file-upload-url';
export const INFURA_URL = 'https://mainnet.infura.io/v3';
export const BINANCE_API_URL = 'https://api.binance.us/api/v3';

export const CRIPTO_YA_URL: string = 'https://criptoya.com/api/ripio/USDT';
export const FIAT_CURRENCIES = ['UYU', 'ARS', 'BRL'];

export const ICP_URL = 'https://ic0.app';
export const PINATA_IPFS_URL = 'https://gateway.pinata.cloud/ipfs';

export const COMMON_REPLY_OPERATION_IN_PROGRESS =
  'The operation is being processed. We will notify you once it is completed or if any issues arise.';

export const COMMON_REPLY_WALLET_NOT_CREATED = `A wallet linked to your phone number hasn't been created yet. Please create one to continue with the operation.`;

export const ALCHEMY_WEBHOOKS_PATH = '/webhooks/alchemy/';
export const EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY =
  EXTERNAL_DEPOSITS_PROVIDER.toLowerCase() === 'alchemy';
export const EXERNAL_DEPOSITS_PROVIDER_IS_THEGRAPH =
  EXTERNAL_DEPOSITS_PROVIDER.toLowerCase() === 'thegraph';
export const ALCHEMY_VALIDATE_WEBHOOK_HEADER_API_KEY: boolean =
  alchemyValidateWebhookHeaderApiKey.toLowerCase() === 'true';

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

export const CORS_ORIGINS_CHECK_POSTMAN: boolean = corsOriginsCheckPostman.toLowerCase() === 'true';
export const CORS_ORIGINS_EXCEPTIONS: string = `/metadata/opensea,/favicon.ico,/docs,${TELEGRAM_WEBHOOK_PATH},${ALCHEMY_WEBHOOKS_PATH}`;

export const COINGECKO_API_BASE_URL = 'https://api.coingecko.com/api/v3/simple/price';
export const TOKEN_IDS = ['usd-coin', 'tether', 'ethereum', 'bitcoin', 'wrapped-bitcoin', 'dai'];
export const RESULT_CURRENCIES = ['usd', 'ars', 'brl', 'uyu'];

export const SWAP_SLIPPAGE_CONFIG_STABLE = Number(slippage_config_stable);
export const SWAP_SLIPPAGE_CONFIG_DEFAULT = Number(slippage_config_default);
export const SWAP_SLIPPAGE_CONFIG_EXTRA = Number(slippage_config_extra);
export const SWAP_ZERO_FEE_MODE: boolean = swapZeroFeeMode.toLowerCase() === 'true';
export const SWAP_EXECUTE_SIMPLE: boolean = swapExecuteSimple.toLowerCase() === 'true';
export const SWAP_USE_QUOTER: boolean = swapUseQuoter.toLowerCase() === 'true';
export const SWAP_PRICE_THRESHOLD_PERCENT: number = Number(swapQuoteVsPricesFeedsThresholdPercent); // %

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

export const CACHE_ERC20_DATA_TTL = 432000; // 5 days
export const CACHE_ERC20_DATA_CHECK_PERIOD = 518400; // 6 days

export const CACHE_CHATTERPOINTS_WORDS_TTL = 1728000; // 20 days
export const CACHE_CHATTERPOINTS_WORDS_CHECK_PERIOD = 1728600; // 20 days + 10 min

// On-Ramp Configuration
export const ONRAMP_BASE_URL = 'https://onramp.money/main/buy/';
export const ONRAMP_APP_ID = '1562916';
export const ONRAMP_DEFAULT_COIN_CODE = 'usdt';
export const ONRAMP_DEFAULT_NETWORK = 'scroll';

// DefiLlama Configuration
export const DEFILLAMA_API_URL = 'https://coins.llama.fi/prices/current';

// Security Configuration
export const SECURITY_PIN_LENGTH = Number(securityPinLength);
export const SECURITY_PIN_MAX_FAILED_ATTEMPTS = Number(securityPinMaxFailedAttempts);
export const SECURITY_PIN_BLOCK_MINUTES = Number(securityPinBlockMinutes);
export const SECURITY_PIN_ENABLED: boolean = securityPinEnabled.toLowerCase() === 'true';
