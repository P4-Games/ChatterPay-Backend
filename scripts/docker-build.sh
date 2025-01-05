#!/bin/bash

# Mover al directorio raíz del proyecto
cd "$(dirname "$0")/.."

# Exportar variables de entorno desde el archivo .env
export $(grep -v '^#' .env | xargs)

# Volver al directorio scripts
cd scripts

# Ejecutar docker build con las variables de entorno como argumentos de compilación
docker build \
  --build-arg ALCHEMY_API_KEY="$ALCHEMY_API_KEY" \
  --build-arg MINOR_LOG_LEVEL="$MINOR_LOG_LEVEL" \
  --build-arg INFURA_API_KEY="$INFURA_API_KEY" \
  --build-arg MONGO_URI="$MONGO_URI" \
  --build-arg PRIVATE_KEY="$PRIVATE_KEY" \
  --build-arg SIGNING_KEY="$SIGNING_KEY" \
  --build-arg PINATA_JWT="$PINATA_JWT" \
  --build-arg ICP_CANISTER_ID="$ICP_CANISTER_ID" \
  --build-arg ICP_MNEMONIC="$ICP_MNEMONIC" \
  --build-arg BOT_API_URL="$BOT_API_URL" \
  --build-arg BOT_DATA_TOKEN="$BOT_DATA_TOKEN" \
  --build-arg ARBITRUM_SEPOLIA_RPC_URL="$ARBITRUM_SEPOLIA_RPC_URL" \
  --build-arg NFT_UPLOAD_IMAGE_ICP="$NFT_UPLOAD_IMAGE_ICP" \
  --build-arg NFT_UPLOAD_IMAGE_IPFS="$NFT_UPLOAD_IMAGE_IPFS" \
  --build-arg GCP_BUCKET_BASE_URL="$GCP_BUCKET_BASE_URL" \
  --build-arg CHATIZALO_TOKEN="$CHATIZALO_TOKEN" \
  --build-arg FRONTEND_TOKEN="$FRONTEND_TOKEN" \
  --build-arg PUSH_ENABLED="$PUSH_ENABLED" \
  --build-arg PUSH_NETWORK="$PUSH_NETWORK" \
  --build-arg PUSH_ENVIRONMENT="$PUSH_ENVIRONMENT" \
  --build-arg PUSH_CHANNEL_ADDRESS="$PUSH_CHANNEL_ADDRESS" \
  --build-arg PUSH_CHANNEL_PRIVATE_KEY="$PUSH_CHANNEL_PRIVATE_KEY" \
  -t chatterpay-back-app ..

