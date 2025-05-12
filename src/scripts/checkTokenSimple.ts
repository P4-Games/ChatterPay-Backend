import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

// ABI fragment for just the functions we need
const factoryAbi = [
  'function globalWhitelistedTokens(address token) external view returns (bool)',
  'function walletImplementation() external view returns (address)',
  'function getProxiesCount() external view returns (uint256)',
  'function getProxies() external view returns (address[] memory)',
  'function getProxyOwnerAddress(address proxy) external view returns (address)' // Added view modifier
];

// Updated interface for a ChatterPay wallet
const walletAbi = [
  'function isTokenWhitelisted(address token) external view returns (bool)'
];

async function main() {
  console.log("Script started");
  
  // Get command line arguments
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: bun src/scripts/checkTokenSimple.ts <factoryAddress> <tokenAddress> [walletAddress]');
    process.exit(1);
  }

  const factoryAddress = args[0];
  const tokenAddress = args[1];
  const specificWalletAddress = args.length > 2 ? args[2] : null;

  console.log(`Checking token: ${tokenAddress}`);
  console.log(`Factory address: ${factoryAddress}`);
  if (specificWalletAddress) {
    console.log(`Specific wallet: ${specificWalletAddress}`);
  }

  // Get RPC URL from environment or use a default value for testing
  const rpcUrl = process.env.RPC_URL || "https://sepolia.infura.io/v3/your-api-key";
  console.log(`Using RPC URL: ${rpcUrl}`);

  // Connect to provider
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  
  try {
    // Connect to the factory contract
    const factory = new ethers.Contract(factoryAddress, factoryAbi, provider);
    
    // Check if token is globally whitelisted
    const isGloballyWhitelisted = await factory.globalWhitelistedTokens(tokenAddress);
    console.log(`Token ${tokenAddress} is ${isGloballyWhitelisted ? 'globally whitelisted' : 'NOT globally whitelisted'} in the factory`);

    // If a specific wallet address was provided, check that wallet
    if (specificWalletAddress) {
      const wallet = new ethers.Contract(specificWalletAddress, walletAbi, provider);
      try {
        // Updated function call
        const isWhitelistedInWallet = await wallet.isTokenWhitelisted(tokenAddress);
        console.log(`Token ${tokenAddress} is ${isWhitelistedInWallet ? 'whitelisted' : 'NOT whitelisted'} in wallet ${specificWalletAddress}`);
      } catch (error) {
        console.error(`Error checking wallet whitelist: ${error.message}`);
      }
      
      try {
        const walletOwner = await factory.getProxyOwnerAddress(specificWalletAddress);
        console.log(`Wallet ${specificWalletAddress} is owned by: ${walletOwner}`);
      } catch (error) {
        console.error(`Could not determine wallet owner: ${error.message}`);
      }
    } else {
      // Check all proxies if no specific wallet was provided
      try {
        const proxiesCount = await factory.getProxiesCount();
        console.log(`Total ChatterPay wallets deployed: ${proxiesCount.toString()}`);
        
        if (proxiesCount.gt(0)) {
          const proxies = await factory.getProxies();
          console.log(`Found ${proxies.length} proxies`);
          
          // Check a limited number of wallets
          const limit = Math.min(proxies.length, 3);
          console.log(`Checking first ${limit} wallets:`);
          
          for (let i = 0; i < limit; i++) {
            const proxyAddress = proxies[i];
            console.log(`\nChecking wallet ${i+1}/${limit}: ${proxyAddress}`);
            
            try {
              const wallet = new ethers.Contract(proxyAddress, walletAbi, provider);
              // Updated function call
              const isWhitelistedInWallet = await wallet.isTokenWhitelisted(tokenAddress);
              console.log(`  Token is ${isWhitelistedInWallet ? 'whitelisted' : 'NOT whitelisted'}`);
            } catch (error) {
              console.error(`  Error checking wallet: ${error.message}`);
            }
          }
          
          if (proxies.length > limit) {
            console.log(`\n... and ${proxies.length - limit} more wallets not checked`);
          }
        }
      } catch (error) {
        console.error(`Error getting proxies: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
  
  console.log("Script completed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });