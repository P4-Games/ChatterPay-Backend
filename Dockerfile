# Use Node.js 20.13.1 as base
FROM node:20.13.1-bullseye AS base

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.1.21" && \
    echo 'export BUN_INSTALL="$HOME/.bun"' >> ~/.bashrc && \
    echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bashrc && \
    echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.profile && \
    echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> ~/.bash_profile

# Ensure Bun is available in PATH
ENV BUN_INSTALL="/root/.bun"
ENV PATH="${BUN_INSTALL}/bin:${PATH}"

# Verify Node.js and Bun versions before starting
RUN node -v && bun -v

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Set the working directory in the container
WORKDIR /app

# Copy environment variables as build arguments
ARG BUN_ENV
ARG INFURA_API_KEY
ARG MAX_FEE_PER_GAS
ARG MAX_PRIORITY_FEE_PER_GAS
ARG VERIFICATION_GAS_LIMIT
ARG CALL_GAS_LIMIT
ARG PRE_VERIFICATION_GAS
ARG MONGO_URI
ARG PRIVATE_KEY
ARG SIGNING_KEY
ARG PINATA_JWT
ARG ICP_CANISTER_ID
ARG ICP_MNEMONIC
ARG BOT_API_URL
ARG BOT_DATA_TOKEN
ARG NFT_UPLOAD_IMAGE_ICP
ARG NFT_UPLOAD_IMAGE_IPFS
ARG GCP_BUCKET_BASE_URL
ARG CHATIZALO_TOKEN
ARG FRONTEND_TOKEN
ARG PUSH_ENABLED
ARG PUSH_NETWORK
ARG PUSH_ENVIRONMENT
ARG PUSH_CHANNEL_ADDRESS
ARG PUSH_CHANNEL_PRIVATE_KEY
ARG MINOR_LOG_LEVEL
ARG MANTECA_BASE_URL
ARG MANTECA_API_KEY
ARG GCP_CLOUD_TRACE_ENABLED
ARG CORS_ORIGINS
ARG BLACKLIST_IPS
ARG DEFAULT_CHAIN_ID
ARG ABIS_VERSION
ARG CORS_ORIGINS_CHECK_POSTMAN
ARG SLIPPAGE_CONFIG_STABLE
ARG SLIPPAGE_CONFIG_DEFAULT
ARG SLIPPAGE_CONFIG_EXTRA
ARG STABLE_TOKENS
ARG ABIS_READ_FROM

# Set environment variables
ENV BUN_ENV $BUN_ENV
ENV INFURA_API_KEY $INFURA_API_KEY
ENV MAX_FEE_PER_GAS $MAX_FEE_PER_GAS
ENV MAX_PRIORITY_FEE_PER_GAS $MAX_PRIORITY_FEE_PER_GAS
ENV VERIFICATION_GAS_LIMIT $VERIFICATION_GAS_LIMIT
ENV CALL_GAS_LIMIT $CALL_GAS_LIMIT
ENV PRE_VERIFICATION_GAS $PRE_VERIFICATION_GAS
ENV MONGO_URI $MONGO_URI
ENV PRIVATE_KEY $PRIVATE_KEY
ENV SIGNING_KEY $SIGNING_KEY
ENV PINATA_JWT $PINATA_JWT
ENV ICP_CANISTER_ID $ICP_CANISTER_ID
ENV ICP_MNEMONIC $ICP_MNEMONIC
ENV BOT_API_URL $BOT_API_URL
ENV BOT_DATA_TOKEN $BOT_DATA_TOKEN
ENV NFT_UPLOAD_IMAGE_ICP $NFT_UPLOAD_IMAGE_ICP
ENV NFT_UPLOAD_IMAGE_IPFS $NFT_UPLOAD_IMAGE_IPFS
ENV GCP_BUCKET_BASE_URL $GCP_BUCKET_BASE_URL
ENV CHATIZALO_TOKEN $CHATIZALO_TOKEN
ENV FRONTEND_TOKEN $FRONTEND_TOKEN
ENV PUSH_ENABLED $PUSH_ENABLED
ENV PUSH_NETWORK $PUSH_NETWORK
ENV PUSH_ENVIRONMENT $PUSH_ENVIRONMENT
ENV PUSH_CHANNEL_ADDRESS $PUSH_CHANNEL_ADDRESS
ENV PUSH_CHANNEL_PRIVATE_KEY $PUSH_CHANNEL_PRIVATE_KEY
ENV MINOR_LOG_LEVEL $MINOR_LOG_LEVEL
ENV MANTECA_BASE_URL $MANTECA_BASE_URL
ENV MANTECA_API_KEY $MANTECA_API_KEY
ENV GCP_CLOUD_TRACE_ENABLED $GCP_CLOUD_TRACE_ENABLED
ENV CORS_ORIGINS $CORS_ORIGINS
ENV BLACKLIST_IPS $BLACKLIST_IPS
ENV DEFAULT_CHAIN_ID $DEFAULT_CHAIN_ID
ENV ABIS_VERSION $ABIS_VERSION
ENV CORS_ORIGINS_CHECK_POSTMAN $CORS_ORIGINS_CHECK_POSTMAN
ENV SLIPPAGE_CONFIG_STABLE $SLIPPAGE_CONFIG_STABLE
ENV SLIPPAGE_CONFIG_DEFAULT $SLIPPAGE_CONFIG_DEFAULT
ENV SLIPPAGE_CONFIG_EXTRA $SLIPPAGE_CONFIG_EXTRA
ENV STABLE_TOKENS $STABLE_TOKENS
ENV ABIS_READ_FROM $ABIS_READ_FROM

# Copy project configuration files
COPY package.json bun.lockb tsconfig.json ./

# Install dependencies securely
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src

# Expose the port where the application runs
EXPOSE 3000
ENV PORT 3000

# Command to run the application
CMD ["bun", "start"]
