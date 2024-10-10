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
    --build-arg INFURA_API_KEY="$INFURA_API_KEY" \
    --build-arg MONGO_URI="$MONGO_URI" \
    --build-arg THRIDWEB_CLIENT_ID="$THRIDWEB_CLIENT_ID" \
    --build-arg THIRDWEB_CLIENT_SECRET="$THIRDWEB_CLIENT_SECRET" \
    --build-arg PRIVATE_KEY="$PRIVATE_KEY" \
    --build-arg SIGNING_KEY="$SIGNING_KEY" \
    --build-arg PINATA_JWT="$PINATA_JWT" \
    --build-arg GATEWAY_URL="$GATEWAY_URL" \
    --build-arg ICP_CANISTER_ID="$ICP_CANISTER_ID" \
    --build-arg ICP_MNEMONIC="$ICP_MNEMONIC" \
    --build-arg BOT_API_URL="$BOT_API_URL" \
    --build-arg BOT_DATA_TOKEN="$BOT_DATA_TOKEN" \
    --build-arg NFT_UPLOAD_IMAGE_ICP="$NFT_UPLOAD_IMAGE_ICP" \
    --build-arg NFT_UPLOAD_IMAGE_IPFS="$NFT_UPLOAD_IMAGE_IPFS" \
    --build-arg GCP_BUCKET_BASE_URL="$GCP_BUCKET_BASE_URL" \
    --build-arg ALCHEMY_AUTH_TOKEN="$ALCHEMY_AUTH_TOKEN" \
    -t chatterpay-back-app ..

