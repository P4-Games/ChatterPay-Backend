import { ethers } from 'ethers';

import { Logger } from '../utils/logger';
import { IBlockchain } from '../models/blockchain';
import { getChatterpayABI } from './bucketService';
import { getNetworkConfig } from './networkService';
import { validateBundlerUrl } from '../utils/bundler';
import { setupContractReturnType } from '../types/common';
import { computeProxyAddressFromPhone } from './predictWalletService';

/**
 * Returns a valid public Bundler RPC URL from Stackup given a chain id
 * @param chainId The chain ID Number
 * @returns {string} (The url)
 */
function getBundlerUrl(chainId: number): string {
  const bundlerUrls: { [key: number]: string | undefined } = {
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
    421614: process.env.ARBITRUM_SEPOLIA_RPC_URL,
    8453: 'https://public.stackup.sh/api/v1/node/base-mainnet',
    84532: 'https://public.stackup.sh/api/v1/node/base-sepolia'
  };

  return bundlerUrls[chainId] || '';
}

/**
 * Sets up the necessary contracts and providers for blockchain interaction.
 * @param blockchain - The blockchain configuration.
 * @param privateKey - The private key for the signer.
 * @param fromNumber - The phone number to compute the proxy address.
 * @returns An object containing the setup contracts and providers.
 * @throws Error if the chain ID is unsupported or the bundler URL is invalid.
 */
export async function setupContracts(
  blockchain: IBlockchain,
  privateKey: string,
  fromNumber: string
): Promise<setupContractReturnType> {
  const bundlerUrl = getBundlerUrl(blockchain.chain_id);
  if (!bundlerUrl) {
    throw new Error(`Unsupported chain ID: ${blockchain.chain_id}`);
  }

  Logger.log(`Validating bundler URL: ${bundlerUrl}`);
  const isValidBundler = await validateBundlerUrl(bundlerUrl);
  if (!isValidBundler) {
    throw new Error(`Invalid or unreachable bundler URL: ${bundlerUrl}`);
  }

  const network = await getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(network.rpc);
  const signer = new ethers.Wallet(privateKey, provider);
  const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
  const proxy = await computeProxyAddressFromPhone(fromNumber);
  const accountExists = true;

  const chatterpayABI = await getChatterpayABI();
  const chatterPayContract = new ethers.Contract(proxy.proxyAddress, chatterpayABI, signer);

  const result: setupContractReturnType = {
    provider,
    signer,
    backendSigner,
    bundlerUrl,
    chatterPay: chatterPayContract,
    proxy,
    accountExists
  };

  return result;
}

/**
 * Sets up an ERC20 token contract.
 * @param tokenAddress - The address of the ERC20 token contract.
 * @param signer - The signer to use for the contract.
 * @returns An ethers.Contract instance for the ERC20 token.
 */
export async function setupERC20(tokenAddress: string, signer: ethers.Wallet) {
  return new ethers.Contract(
    tokenAddress,
    [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)'
    ],
    signer
  );
}
