#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Resolve the path to the .env file
ENV_FILE="./.env"

# Function to load .env file
load_env() {
    if [ -f "$ENV_FILE" ]; then
        echo -e "${YELLOW}Loading environment variables from $ENV_FILE${NC}"
        export $(grep -v '^#' "$ENV_FILE" | xargs)
    else
        echo -e "${RED}Warning: .env file not found at $ENV_FILE${NC}"
    fi
}

# Function to display script usage
usage() {
    echo "Usage: $0 [options]"
    echo
    echo "Options:"
    echo "  validate     Run swap prerequisite validation script"
    echo "  swap-eoa     Execute a direct swap using EOA"
    echo "  swap-proxy   Execute a direct swap through proxy"
    echo "  proxy        Create a new proxy wallet"
    echo "  all          Run all scripts in sequence"
    echo
    echo "Environment Variables:"
    echo "  Configure in $ENV_FILE:"
    echo "  - INFURA_API_KEY"
    echo "  - SIGNING_KEY or PRIVATE_KEY"
    exit 1
}

# Check if Bun is installed
check_bun() {
    if ! command -v bun &> /dev/null; then
        echo -e "${RED}Error: Bun is not installed. Please install Bun first.${NC}"
        exit 1
    fi
}

# Run prerequisite validation script
run_validate() {
    echo -e "${YELLOW}Running Swap Prerequisite Validation Script...${NC}"
    bun run scripts/swap_debug/pre_swap_validations.ts
}

# Run direct swap script (EOA to Uniswap)
run_eoa_swap() {
    echo -e "${YELLOW}Running Direct Swap Execution Script...${NC}"
    bun run scripts/swap_debug/eoa_direct_swap.ts
}

# Run direct swap script (Using owner EOA to interact with Uniswap through the proxy)
run_proxy_swap() {
    echo -e "${YELLOW}Running Direct Swap Execution Script...${NC}"
    bun run scripts/swap_debug/proxy_direct_swap.ts
}

# Run proxy creation script
run_proxy() {
    echo -e "${YELLOW}Running Proxy Creation Script...${NC}"
    bun run scripts/swap_debug/create_proxy.ts
}

# Validate inputs
validate_inputs() {
    # Check critical environment variables
    local required_vars=(
        "INFURA_API_KEY"
        "SIGNING_KEY"
    )

    local missing_vars=()

    for var in "${required_vars[@]}"; do
        if [[ -z "${!var}" ]]; then
            missing_vars+=("$var")
        fi
    done

    if [[ ${#missing_vars[@]} -gt 0 ]]; then
        echo -e "${RED}Error: Missing required environment variables:${NC}"
        printf '%s\n' "${missing_vars[@]}"
        echo -e "${YELLOW}Ensure they are set in $ENV_FILE${NC}"
        exit 1
    fi
}

# Main script execution
main() {
    # Load environment variables
    load_env

    # Check for Bun
    check_bun

    # Parse command line argument
    case "$1" in
        validate)
            validate_inputs
            run_validate
            ;;
        eoa-swap)
            validate_inputs
            run_eoa_swap
            ;;
        proxy-swap)
            validate_inputs
            run_proxy_swap
            ;;
        proxy)
            validate_inputs
            run_proxy
            ;;
        all)
            validate_inputs
            run_proxy
            run_validate
            run_eoa_swap
            run_proxy_swap
            ;;
        *)
            usage
            ;;
    esac
}

# Execute main with arguments
main "$@"