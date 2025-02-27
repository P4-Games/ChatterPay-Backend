import dotenv from 'dotenv';
import { ethers } from 'ethers';

import { Logger } from '../../src/helpers/loggerHelper';

// Load environment variables
dotenv.config();

/**
 * Script to create a new proxy directly with the Factory
 * Without using Account Abstraction (no UserOp or Paymaster)
 */
async function createProxy(
    provider: ethers.providers.Provider,
    signer: ethers.Wallet,
    factoryAddress: string,
    ownerAddress: string
): Promise<string> {
    Logger.info('createProxy', '=====================================================');
    Logger.info('createProxy', 'CREATING NEW PROXY WALLET');
    Logger.info('createProxy', '=====================================================');

    // Factory ABI for creating proxy
    const factoryABI = [
        "function createProxy(address _owner) external returns (address)",
        "function computeProxyAddress(address _owner) external view returns (address)",
        "function getProxies() external view returns (address[])",
        "function owner() external view returns (address)"
    ];

    Logger.info('createProxy', `\n1. Connecting to Factory: ${factoryAddress}`);
    const factory = new ethers.Contract(factoryAddress, factoryABI, signer);

    // Verify authorization (optional)
    const factoryOwner = await factory.owner();
    Logger.info('createProxy', `Factory owner: ${factoryOwner}`);
    Logger.info('createProxy', `Transaction signer: ${signer.address}`);

    // Calculate the proxy address before creating it
    Logger.info('createProxy', `\n2. Calculating future proxy address...`);
    try {
        const expectedAddress = await factory.computeProxyAddress(ownerAddress);
        Logger.info('createProxy', `Expected proxy address: ${expectedAddress}`);
    } catch (error: unknown) {
        Logger.warn('createProxy', `Could not calculate future address: ${(error as Error).message}`);
    }

    // Get existing proxies
    Logger.info('createProxy', `\n3. Verifying existing proxies...`);
    const existingProxies = await factory.getProxies();
    Logger.info('createProxy', `Existing proxies: ${existingProxies.length}`);

    // eslint-disable-next-line no-restricted-syntax
    for (const proxy of existingProxies) {
        Logger.debug('createProxy', `- ${proxy}`);
    }

    // Create the proxy
    Logger.info('createProxy', `\n4. Creating new proxy with owner: ${ownerAddress}...`);

    try {
        // Get gas settings from environment or use defaults
        const gasLimit = process.env.GAS_LIMIT ? parseInt(process.env.GAS_LIMIT, 10) : 5000000;
        const gasPrice = process.env.GAS_PRICE ? ethers.utils.parseUnits(process.env.GAS_PRICE, 'gwei') : undefined;
        
        const txOptions: {gasLimit: number, gasPrice?: ethers.BigNumber} = {
            gasLimit
        };
        
        if (gasPrice) txOptions.gasPrice = gasPrice;

        Logger.info('createProxy', 'Sending transaction...');
        Logger.debug('createProxy', 'Transaction options:', txOptions);
        
        const tx = await factory.createProxy(ownerAddress, txOptions);

        Logger.info('createProxy', `Transaction sent: ${tx.hash}`);
        Logger.info('createProxy', 'Waiting for confirmation...');

        const receipt = await tx.wait();
        Logger.info('createProxy', `Transaction confirmed in block: ${receipt.blockNumber} (gas used: ${receipt.gasUsed.toString()})`);

        // Look for the ProxyCreated event in the logs
        const proxyAddress = findProxyAddressFromLogs(receipt.logs, ownerAddress);

        if (proxyAddress) {
            Logger.info('createProxy', `\n✅ SUCCESS! New proxy created at: ${proxyAddress}`);
            return proxyAddress;
        }

        // Get the proxies again to find the new one
        const updatedProxies = await factory.getProxies();
        const newProxies = updatedProxies.filter((p: unknown) => !existingProxies.includes(p));

        if (newProxies.length > 0) {
            Logger.info('createProxy', `\n✅ SUCCESS! New proxy created at: ${newProxies[0]}`);
            return newProxies[0] as string;
        }

        Logger.error('createProxy', `\n❌ Could not identify the address of the new proxy`);
        return '';

    } catch (error: unknown) {
        Logger.error('createProxy', `\n❌ ERROR creating proxy: ${(error as Error).message}`);

        // Check if the error is related to insufficient gas
        if ((error as Error).message.includes('gas') || (error as Error).message.includes('insufficient funds')) {
            Logger.info('createProxy', '\nSuggestion: Could be a gas issue. Verify your wallet has sufficient ETH.');
        }

        return '';
    }
}

// Function to find the proxy address in the logs
function findProxyAddressFromLogs(logs: ethers.providers.Log[], ownerAddress: string): string {
    // The ProxyCreated event has a format similar to:
    // event ProxyCreated(address indexed owner, address indexed proxyAddress);

    return logs.reduce((result, log) => {
        // If we already found a result, keep it
        if (result) return result;

        // Try to identify the event by its structure
        if (log.topics.length === 3) {
            // First topic is the event hash
            // Second topic should be the owner (indexed)
            // Third topic should be the proxy (indexed)

            // Convert indexed address to address format
            const topicOwner = `0x${log.topics[1].slice(26)}`;
            const topicProxy = `0x${log.topics[2].slice(26)}`;

            // Compare with the owner we're looking for (case insensitive)
            if (topicOwner.toLowerCase() === ownerAddress.toLowerCase()) {
                return topicProxy;
            }
        }
        return result;
    }, '');
}

// Main function
async function main() {
    try {
        // Get environment variables
        const SIGNING_KEY = process.env.SIGNING_KEY || process.env.PRIVATE_KEY;
        const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || "0xeCD34e3CB296Ed7c4a875290d49217f2C7cFf95b";

        // RPC configuration
        const { INFURA_API_KEY, RPC_URL } = process.env;
        const rpcUrl = `${RPC_URL ?? "https://arbitrum-sepolia.infura.io/v3/"}${INFURA_API_KEY}`;

        // Verify we have the necessary variables
        if (!INFURA_API_KEY) {
            Logger.error('main', 'ERROR: INFURA_API_KEY missing in .env file');
            process.exit(1);
        }

        if (!SIGNING_KEY) {
            Logger.error('main', 'ERROR: SIGNING_KEY or PRIVATE_KEY missing in .env file');
            process.exit(1);
        }

        if (!FACTORY_ADDRESS) {
            Logger.error('main', 'ERROR: FACTORY_ADDRESS missing in .env file');
            process.exit(1);
        }

        // Configure provider and signer
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const signer = new ethers.Wallet(SIGNING_KEY, provider);

        Logger.info('main', `Executing as: ${signer.address}`);

        // By default, the proxy owner will be the same address that signs the transaction
        const ownerAddress = process.env.OWNER_ADDRESS || signer.address;

        // Create the proxy
        const proxyAddress = await createProxy(
            provider,
            signer,
            FACTORY_ADDRESS,
            ownerAddress
        );

        if (proxyAddress) {
            // Save the proxy address for future use
            Logger.info('main', '\n=====================================================');
            Logger.info('main', 'NEW PROXY INFORMATION');
            Logger.info('main', '=====================================================');
            Logger.info('main', `Address: ${proxyAddress}`);
            Logger.info('main', `Owner: ${ownerAddress}`);
            Logger.info('main', `Network: ${(await provider.getNetwork()).name} (${(await provider.getNetwork()).chainId})`);
            Logger.info('main', '=====================================================');
            Logger.info('main', 'Add this address to your .env as PROXY_ADDRESS to use it in other scripts');

            process.exit(0);
        } else {
            process.exit(1);
        }
    } catch (error) {
        Logger.error('main', 'Fatal error during execution:', error);
        process.exit(1);
    }
}

// Run the script
main();