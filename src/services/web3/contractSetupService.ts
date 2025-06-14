import { ethers } from 'ethers';

import { SIGNING_KEY } from '../../config/constants';
import { IBlockchain } from '../../models/blockchainModel';
import { IUser, IUserWallet } from '../../models/userModel';
import { getERC20ABI, getChatterpayABI } from './abiService';
import { generateWalletSeed } from '../../helpers/SecurityHelper';
import { mongoBlockchainService } from '../mongo/mongoBlockchainService';
import { ComputedAddress, SetupContractReturn } from '../../types/commonType';

/**
 * Sets up the necessary contracts and providers for blockchain interaction.
 * @param blockchain - The blockchain configuration.
 * @param user - usser to compute private key and proxy-wallet
 * @returns An object containing the setup contracts and providers.
 * @throws Error if the chain ID is unsupported or the bundler URL is invalid.
 */
export async function setupContracts(
  blockchain: IBlockchain,
  user: IUser
): Promise<SetupContractReturn> {
  const network = await mongoBlockchainService.getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(network.rpc);

  const privateKey = generateWalletSeed(user.phone_number, blockchain.chainId.toString());
  const signer = new ethers.Wallet(privateKey, provider);
  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const userWallet: IUserWallet = user.wallets[0];
  const computedAddress: ComputedAddress = {
    proxyAddress: userWallet.wallet_proxy,
    EOAAddress: userWallet.wallet_eoa,
    privateKey: userWallet.sk_hashed,
    privateKeyNotHashed: privateKey
  };
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
    proxy: computedAddress,
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
