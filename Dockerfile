# Usa la imagen oficial de Bun
FROM oven/bun:1

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

ARG BUN_ENV
ARG ALCHEMY_API_KEY
ARG INFURA_API_KEY
ARG MONGO_URI
ARG THRIDWEB_CLIENT_ID
ARG THIRDWEB_CLIENT_SECRET
ARG PRIVATE_KEY
ARG SIGNING_KEY
ARG PINATA_JWT
ARG GATEWAY_URL
ARG ICP_CANISTER_ID
ARG ICP_MNEMONIC
ARG BOT_API_URL
ARG BOT_DATA_TOKEN
ARG NFT_UPLOAD_IMAGE_ICP
ARG NFT_UPLOAD_IMAGE_IPFS
ARG GCP_BUCKET_BASE_URL
ARG CHATIZALO_TOKEN
ARG FRONTEND_TOKEN

ENV BUN_ENV prodution
ENV ALCHEMY_API_KEY $ALCHEMY_API_KEY
ENV INFURA_API_KEY $INFURA_API_KEY
ENV MONGO_URI $MONGO_URI
ENV THRIDWEB_CLIENT_ID $THRIDWEB_CLIENT_ID
ENV THIRDWEB_CLIENT_SECRET $THIRDWEB_CLIENT_SECRET
ENV PRIVATE_KEY $PRIVATE_KEY
ENV SIGNING_KEY $SIGNING_KEY
ENV PINATA_JWT $PINATA_JWT
ENV GATEWAY_URL $GATEWAY_URL
ENV ICP_CANISTER_ID $ICP_CANISTER_ID
ENV ICP_MNEMONIC $ICP_MNEMONIC
ENV BOT_API_URL $BOT_API_URL
ENV BOT_DATA_TOKEN $BOT_DATA_TOKEN
ENV NFT_UPLOAD_IMAGE_ICP $NFT_UPLOAD_IMAGE_ICP
ENV NFT_UPLOAD_IMAGE_IPFS $NFT_UPLOAD_IMAGE_IPFS
ENV GCP_BUCKET_BASE_URL $GCP_BUCKET_BASE_URL
ENV CHATIZALO_TOKEN $CHATIZALO_TOKEN
ENV FRONTEND_TOKEN $FRONTEND_TOKEN

# Copia los archivos de configuración del proyecto
COPY package.json bun.lockb tsconfig.json ./

# Instala las dependencias
RUN bun install --frozen-lockfile

# Copia el código fuente
COPY src ./src

# Expone el puerto en el que se ejecuta la aplicación
EXPOSE 3000
ENV PORT 3000
# Comando para ejecutar la aplicación
CMD ["bun", "start"]

