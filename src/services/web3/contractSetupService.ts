import { ethers } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { SIGNING_KEY } from '../../config/constants';
import { getChatterpayABI } from '../gcp/gcpService';
import { IBlockchain } from '../../models/blockchainModel';
import { SetupContractReturnType } from '../../types/commonType';
import { computeProxyAddressFromPhone } from '../predictWalletService';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';

/**
 * Validate Bundle Url
 * @param url
 * @returns
 */
async function validateBundlerUrl(url: string): Promise<boolean> {
  try {
    const provider = new ethers.providers.JsonRpcProvider(url);
    await provider.getNetwork();
    return true;
  } catch (error) {
    Logger.error('validateBundlerUrl', `Failed to validate bundler URL ${url}:`, error);
    return false;
  }
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
): Promise<SetupContractReturnType> {
  const rpUrl = blockchain.rpc;
  if (!rpUrl) {
    throw new Error(`Unsupported chain ID: ${blockchain.chain_id}`);
  }

  Logger.log('setupContracts', `Validating RPC URL: ${rpUrl}`);
  const isValidBundler = await validateBundlerUrl(rpUrl);
  if (!isValidBundler) {
    throw new Error(`Invalid or unreachable RPC URL: ${rpUrl}`);
  }

  const network = await mongoBlockchainService.getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(network.rpc);
  const signer = new ethers.Wallet(privateKey, provider);
  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const proxy = await computeProxyAddressFromPhone(fromNumber);
  const accountExists = true;

  const chatterpayABI = await getChatterpayABI();
  const chatterPayContract = new ethers.Contract(proxy.proxyAddress, chatterpayABI, signer);

  const result: SetupContractReturnType = {
    provider,
    signer,
    backendSigner,
    bundlerUrl: rpUrl,
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
