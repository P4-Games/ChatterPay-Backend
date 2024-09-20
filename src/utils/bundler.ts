import { ethers } from "ethers";

/**
 * Returns a valid public Bundler RPC URL from Stackup given a chain id
 * @param chainId The chain ID Number
 * @returns {string} (The url)
 */
export function getBundlerUrl(chainId: number): string {
    const bundlerUrls: { [key: number]: string } = {
        1: 'https://public.stackup.sh/api/v1/node/ethereum-mainnet',
        11155111: 'https://public.stackup.sh/api/v1/node/ethereum-sepolia',
        137: 'https://public.stackup.sh/api/v1/node/polygon-mainnet',
        80001: 'https://public.stackup.sh/api/v1/node/polygon-mumbai',
        43114: 'https://public.stackup.sh/api/v1/node/avalanche-mainnet',
        43113: 'https://public.stackup.sh/api/v1/node/avalanche-fuji',
        10: 'https://public.stackup.sh/api/v1/node/optimism-mainnet',
        11155420: 'https://public.stackup.sh/api/v1/node/optimism-sepolia',
        56: 'https://public.stackup.sh/api/v1/node/bsc-mainnet',
        97: 'https://public.stackup.sh/api/v1/node/bsc-testnet',
        42161: 'https://public.stackup.sh/api/v1/node/arbitrum-one',
        421614: 'https://arbitrum-sepolia.voltaire.candidewallet.com/rpc',
        8453: 'https://public.stackup.sh/api/v1/node/base-mainnet',
        84532: 'https://public.stackup.sh/api/v1/node/base-sepolia',
    };

    return bundlerUrls[chainId] || '';
}

export async function validateBundlerUrl(url: string): Promise<boolean> {
    try {
        const provider = new ethers.providers.JsonRpcProvider(url);
        await provider.getNetwork();
        return true;
    } catch (error) {
        console.error(`Failed to validate bundler URL ${url}:`, error);
        return false;
    }
}