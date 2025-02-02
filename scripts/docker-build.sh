#!/bin/bash

# Mover al directorio raíz del proyecto
cd "$(dirname "$0")/.."

# Exportar variables de entorno desde el archivo .env
export $(grep -v '^#' .env | xargs)

# Volver al directorio scripts
cd scripts

# Ejecutar docker build con las variables de entorno como argumentos de compilación
docker build \
  --build-arg BUN_ENV="$BUN_ENV" \
  --build-arg INFURA_API_KEY="$INFURA_API_KEY" \
  --build-arg MONGO_URI="$MONGO_URI" \
  --build-arg PRIVATE_KEY="$PRIVATE_KEY" \
  --build-arg SIGNING_KEY="$SIGNING_KEY" \
  --build-arg PINATA_JWT="$PINATA_JWT" \
  --build-arg ICP_CANISTER_ID="$ICP_CANISTER_ID" \
  --build-arg ICP_MNEMONIC="$ICP_MNEMONIC" \
  --build-arg BOT_NOTIFICATIONS_ENABLED="$BOT_NOTIFICATIONS_ENABLED" \
  --build-arg BOT_API_URL="$BOT_API_URL" \
  --build-arg BOT_DATA_TOKEN="$BOT_DATA_TOKEN" \
  --build-arg NFT_UPLOAD_IMAGE_ICP="$NFT_UPLOAD_IMAGE_ICP" \
  --build-arg NFT_UPLOAD_IMAGE_IPFS="$NFT_UPLOAD_IMAGE_IPFS" \
  --build-arg GCP_BUCKET_BASE_URL="$GCP_BUCKET_BASE_URL" \
  --build-arg FRONTEND_TOKEN="$FRONTEND_TOKEN" \
  --build-arg CHATIZALO_TOKEN="$CHATIZALO_TOKEN" \
  --build-arg ARBITRUM_SEPOLIA_RPC_URL="$ARBITRUM_SEPOLIA_RPC_URL" \
  --build-arg PUSH_CHANNEL_ADDRESS="$PUSH_CHANNEL_ADDRESS" \
  --build-arg PUSH_CHANNEL_PRIVATE_KEY="$PUSH_CHANNEL_PRIVATE_KEY" \
  --build-arg PUSH_ENABLED="$PUSH_ENABLED" \
  --build-arg PUSH_NETWORK="$PUSH_NETWORK" \
  --build-arg PUSH_ENVIRONMENT="$PUSH_ENVIRONMENT" \
  --build-arg BACKEND_ENDPINT_TOKEN_ISSUE="$BACKEND_ENDPINT_TOKEN_ISSUE" \
  --build-arg MINOR_LOG_LEVEL="$MINOR_LOG_LEVEL" \
  --build-arg MAX_FEE_PER_GAS="$MAX_FEE_PER_GAS" \
  --build-arg MAX_PRIORITY_FEE_PER_GAS="$MAX_PRIORITY_FEE_PER_GAS" \
  --build-arg VERIFICATION_GAS_LIMIT="$VERIFICATION_GAS_LIMIT" \
  --build-arg CALL_GAS_LIMIT="$CALL_GAS_LIMIT" \
  --build-arg PRE_VERIFICATION_GAS="$PRE_VERIFICATION_GAS" \
  --build-arg MANTECA_BASE_URL="$MANTECA_BASE_URL" \
  --build-arg MANTECA_API_KEY="$MANTECA_API_KEY" \
  --build-arg GCP_CLOUD_TRACE_ENABLED="$GCP_CLOUD_TRACE_ENABLED" \
  --build-arg CORS_ORIGINS="$CORS_ORIGINS" \
  --build-arg CORS_ORIGINS_CHECK_POSTMAN="$CORS_ORIGINS_CHECK_POSTMAN" \
  --build-arg BLACKLIST_IPS="$BLACKLIST_IPS" \
  --build-arg DEFAULT_CHAIN_ID="$DEFAULT_CHAIN_ID" \
  --build-arg ABIS_VERSION="$ABIS_VERSION" \
  -t chatterpay-back-app ..

