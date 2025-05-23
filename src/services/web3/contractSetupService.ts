import { ethers } from 'ethers';

import { SIGNING_KEY } from '../../config/constants';
import { IBlockchain } from '../../models/blockchainModel';
import { SetupContractReturn } from '../../types/commonType';
import { getERC20ABI, getChatterpayABI } from './abiService';
import { computeProxyAddressFromPhone } from '../predictWalletService';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';

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
): Promise<SetupContractReturn> {
  const network = await mongoBlockchainService.getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(network.rpc);
  const signer = new ethers.Wallet(privateKey, provider);
  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const proxy = await computeProxyAddressFromPhone(fromNumber);
  const accountExists = true;

  const chatterpayABI = await getChatterpayABI();
  const chatterPayContract = new ethers.Contract(
    blockchain.contracts.chatterPayAddress,
    chatterpayABI,
    signer
  );

  const result: SetupContractReturn = {
    provider,
    signer,
    backendSigner,
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
  const ERC20ABI = await getERC20ABI();
  return new ethers.Contract(tokenAddress, ERC20ABI, signer);
}
