import { IToken } from '../models/token';
import Blockchain, { IBlockchain } from '../models/blockchain';

export interface TokenAddresses {
  tokenAddressInput: string;
  tokenAddressOutput: string;
}

/**
 * Retrieves a blockchain by its chain ID.
 *
 * @param chain_id - The unique identifier of the blockchain.
 * @returns A promise that resolves to the blockchain information.
 * @throws Error if the blockchain with the specified chain ID is not found.
 */
export async function getBlockchain(chain_id: number): Promise<IBlockchain> {
  const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
  if (!blockchain) {
    throw new Error(`Blockchain with chain_id ${chain_id} not found`);
  }
  return blockchain;
}

/**
 * Gets token address based on Token symbols
 */
export function getTokenAddress(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbol: string
): string {
  if (!blockchainTokens) return '';

  const chainTokens = blockchainTokens.filter(
    (token) => token.chain_id === blockchainConfig.chain_id
  );

  const foundToken = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbol.toLowerCase()
  );

  return foundToken?.address ?? '';
}

/**
 * Gets tokens addresses based on Tokens symbols
 */
export function getTokensAddresses(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbolInput: string,
  lookUpTokenSymbolOutput: string
): TokenAddresses {
  const chainTokens = blockchainTokens.filter(
    (token) => token.chain_id === blockchainConfig.chain_id
  );

  const foundTokenInput = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbolInput.toLowerCase()
  );
  const foundTokenOutput = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbolOutput.toLowerCase()
  );

  return {
    tokenAddressInput: foundTokenInput?.address ?? '',
    tokenAddressOutput: foundTokenOutput?.address ?? ''
  };
}

/**
 * Helper function to ensure the User signer has enough ETH for gas fees.
 *
 * @param userSignerWalletAdddress
 * @param backendSignerWallet
 * @param provider
 * @returns
 */
export async function ensureUserSignerHasEnoughEth(
  userSignerWalletAdddress: string,
  backendSignerWallet: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    const backendSignerWalletAddress = await backendSignerWallet.getAddress();
    Logger.log(
      `Checking if User EOA ${userSignerWalletAdddress} has minimal funds (${USER_SIGNER_MIN_BALANCE}) to sign the transaction.`
    );

    const EOABalance = await provider.getBalance(userSignerWalletAdddress);
    Logger.log(
      `User EOA ${userSignerWalletAdddress} balance: ${ethers.utils.formatEther(EOABalance)} ETH.`
    );

    if (EOABalance.lt(ethers.utils.parseEther(USER_SIGNER_MIN_BALANCE))) {
      Logger.log(
        `Sending ${USER_SIGNER_BALANCE_TO_TRANSFER} ETH from backendSigner ${backendSignerWalletAddress} ` +
          `to User EOA ${userSignerWalletAdddress}.`
      );

      const tx = await backendSignerWallet.sendTransaction({
        to: userSignerWalletAdddress,
        value: ethers.utils.parseEther(USER_SIGNER_BALANCE_TO_TRANSFER),
        gasLimit: 210000
      });

      await tx.wait();
      Logger.log('ETH sent to user EOA');
    } else {
      Logger.log('User EOA has enough ETH to sign.');
    }
    return true;
  } catch (error: unknown) {
    Logger.error(
      `Error checking if EOA Signer has minimal funds to make the transaction. Error: ${(error as Error).message}`
    );
    return false;
  }
}

/**
 * Helper function to ensure the backend Signer has enough ETH for gas fees.
 *
 * @param backendSignerWalletAddress
 * @param provider
 * @returns
 */
export async function ensureBackendSignerHasEnoughEth(
  backendSignerWalletAddress: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    Logger.log(
      `Checking if Backend Signer ${backendSignerWalletAddress} has minimal funds (${BACKEND_SIGNER_MIN_BALANCE}) to make transactions.`
    );

    const walletBalance = await provider.getBalance(backendSignerWalletAddress);
    const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);
    Logger.log(
      `Backend Signer ${backendSignerWalletAddress} balance: ${walletBalanceFormatted} ETH.`
    );

    if (walletBalance.lt(ethers.utils.parseEther(BACKEND_SIGNER_MIN_BALANCE))) {
      Logger.error(
        `Backend Signer ${backendSignerWalletAddress} current balance: ${walletBalanceFormatted} ETH, ` +
          `balance required: ${BACKEND_SIGNER_MIN_BALANCE} ETH.`
      );
      return false;
    }

    Logger.log('Backend Signer has enough ETH.');
    return true;
  } catch (error: unknown) {
    Logger.error(
      `Error checking if Backend Signer has minimal funds to make transactions. Error: ${(error as Error).message}`
    );
    return false;
  }
}
