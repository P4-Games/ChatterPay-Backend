import { ethers } from 'ethers';

import { Logger } from '../helpers/loggerHelper';
import { getEntryPointABI } from './web3/abiService';
import { IUser, UserModel } from '../models/userModel';
import { setupContracts } from './web3/contractSetupService';
import { ensurePaymasterHasEnoughEth } from './web3/paymasterService';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import Token, { IToken, TokenOperationLimits } from '../models/tokenModel';
import { IBlockchain, BlockchainOperationLimits } from '../models/blockchainModel';
import {
  swapTokensData,
  SetupContractReturn,
  CheckBalanceConditionsResult
} from '../types/commonType';

/**
 * Gets token info based on token address or symbol
 * @param blockchainConfig
 * @param blockchainTokens
 * @param tokenSimbolOrAddress
 * @returns {TokenInfo | undefined}
 */
export function getTokenInfo(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  tokenSimbolOrAddress: string
): IToken | undefined {
  if (!blockchainTokens) return undefined;

  const chainTokens = blockchainTokens.filter(
    (token) => token.chain_id === blockchainConfig.chainId
  );

  const foundToken = chainTokens.find(
    (t) =>
      t.symbol.toLowerCase() === tokenSimbolOrAddress.toLowerCase() ||
      t.address.toLowerCase() === tokenSimbolOrAddress.toLowerCase()
  );

  return foundToken;
}

/**
 * Gets token address based on Token symbols
 *
 * @param blockchainConfig
 * @param blockchainTokens
 * @param lookUpTokenSymbol
 * @returns
 */
export function getTokenData(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbol: string
): IToken | undefined {
  const chainTokens = blockchainTokens.filter(
    (token) => token.chain_id === blockchainConfig.chainId
  );

  const foundToken = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbol.toLowerCase()
  );

  return foundToken;
}

/**
 * Gets tokens addresses based on Tokens symbols
 *
 * @param blockchainConfig
 * @param blockchainTokens
 * @param lookUpTokenSymbolInput
 * @param lookUpTokenSymbolOutput
 * @returns
 */
export function getSwapTokensData(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbolInput: string,
  lookUpTokenSymbolOutput: string
): swapTokensData {
  const chainTokens = blockchainTokens.filter(
    (token) => token.chain_id === blockchainConfig.chainId
  );

  const foundTokenInput = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbolInput.toLowerCase()
  );
  const foundTokenOutput = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbolOutput.toLowerCase()
  );

  return {
    tokenInputAddress: foundTokenInput?.address ?? '',
    tokenInputSymbol: lookUpTokenSymbolInput,
    tokenInputDisplaySymbol: foundTokenInput?.display_symbol ?? lookUpTokenSymbolInput,
    tokenOutputAddress: foundTokenOutput?.address ?? '',
    tokenOutputSymbol: lookUpTokenSymbolInput,
    tokenOutputDisplaySymbol: foundTokenOutput?.display_symbol ?? lookUpTokenSymbolOutput
  };
}

/**
 * Helper function to ensure the backend Signer has enough ETH for gas fees.
 *
 * @param backendSignerWalletAddress
 * @param provider
 * @returns
 */
export async function ensureBackendSignerHasEnoughEth(
  blockchainBalances: IBlockchain['balances'],
  backendSignerWalletAddress: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    Logger.log(
      'ensureBackendSignerHasEnoughEth',
      `Checking if Backend Signer ${backendSignerWalletAddress} has minimal funds (${blockchainBalances.backendSignerMinBalance}) to make transactions.`
    );

    const walletBalance = await provider.getBalance(backendSignerWalletAddress);
    const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);
    Logger.log(
      'ensureBackendSignerHasEnoughEth',
      `Backend Signer ${backendSignerWalletAddress} balance: ${walletBalanceFormatted} ETH.`
    );

    if (walletBalance.lt(ethers.utils.parseEther(blockchainBalances.backendSignerMinBalance))) {
      Logger.error(
        'ensureBackendSignerHasEnoughEth',
        `Backend Signer ${backendSignerWalletAddress} current balance: ${walletBalanceFormatted} ETH, ` +
          `balance required: ${blockchainBalances.backendSignerMinBalance} ETH.`
      );
      return false;
    }

    Logger.log('ensureBackendSignerHasEnoughEth', 'Backend Signer has enough ETH.');
    return true;
  } catch (error: unknown) {
    Logger.error(
      'ensureBackendSignerHasEnoughEth',
      `Error checking if Backend Signer has minimal funds to make transactions. Error: ${(error as Error).message}`
    );
    return false;
  }
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
  blockchainBalances: IBlockchain['balances'],
  userSignerWalletAdddress: string,
  backendSignerWallet: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    const backendSignerWalletAddress = await backendSignerWallet.getAddress();
    Logger.log(
      'ensureUserSignerHasEnoughEth',
      `Checking if User EOA ${userSignerWalletAdddress} has minimal funds (${blockchainBalances.userSignerMinBalance}) to sign the transaction.`
    );

    const EOABalance = await provider.getBalance(userSignerWalletAdddress);
    Logger.log(
      'ensureUserSignerHasEnoughEth',
      `User EOA ${userSignerWalletAdddress} balance: ${ethers.utils.formatEther(EOABalance)} ETH.`
    );

    if (EOABalance.lt(ethers.utils.parseEther(blockchainBalances.userSignerMinBalance))) {
      Logger.log(
        'ensureUserSignerHasEnoughEth',
        `Sending ${blockchainBalances.userSignerBalanceToTransfer} ETH from backendSigner ${backendSignerWalletAddress} ` +
          `to User EOA ${userSignerWalletAdddress}.`
      );

      const gasPrice = await provider.getGasPrice();
      const tx = await backendSignerWallet.sendTransaction({
        to: userSignerWalletAdddress,
        value: ethers.utils.parseEther(blockchainBalances.userSignerBalanceToTransfer),
        gasLimit: 210000,
        gasPrice
      });

      await tx.wait();
      Logger.log('ensureUserSignerHasEnoughEth', 'ETH sent to user EOA');
    } else {
      Logger.log('ensureUserSignerHasEnoughEth', 'User EOA has enough ETH to sign.');
    }
    return true;
  } catch (error: unknown) {
    Logger.error(
      'ensureUserSignerHasEnoughEth',
      `Error checking if EOA Signer has minimal funds to make the transaction. Error: ${(error as Error).message}`
    );
    return false;
  }
}

/**
 * Checks blockchain-related conditions for a given user.
 * Validates balance, deployment status, and readiness of associated contracts.
 *
 * @param networkConfig - The blockchain network configuration (RPC, contracts, etc.)
 * @param user - The user object to check (including phone, wallet, etc.)
 * @returns A promise that resolves with the result of all blockchain condition checks.
 */
export async function checkBlockchainConditions(
  networkConfig: IBlockchain,
  user: IUser
): Promise<CheckBalanceConditionsResult> {
  try {
    const blockchain: IBlockchain | null = await mongoBlockchainService.getBlockchain(
      networkConfig.chainId
    );

    if (!blockchain) {
      throw new Error(`Blockchain with chain_id ${networkConfig.chainId} not found`);
    }

    const setupContractsResult: SetupContractReturn = await setupContracts(blockchain, user);

    Logger.log('checkBlockchainConditions', 'Validating account');
    if (!setupContractsResult.accountExists) {
      throw new Error(
        `Account ${setupContractsResult.proxy.proxyAddress} does not exist. Cannot proceed with user operation.`
      );
    }

    const backendSignerWalletAddress = await setupContractsResult.backendSigner.getAddress();
    const checkBackendSignerBalanceresult = await ensureBackendSignerHasEnoughEth(
      networkConfig.balances,
      backendSignerWalletAddress,
      setupContractsResult.provider
    );
    if (!checkBackendSignerBalanceresult) {
      throw new Error(
        `Backend Signer Wallet ${backendSignerWalletAddress}, insufficient ETH balance.`
      );
    }

    /*
    const userWalletAddress = await setupContractsResult.signer.getAddress();
    const checkUserEthBalanceResult = await ensureUserSignerHasEnoughEth(
      networkConfig.balances,
      userWalletAddress,
      setupContractsResult.backendSigner,
      setupContractsResult.provider
    );
    if (!checkUserEthBalanceResult) {
      throw new Error(
        `User Wallet ${setupContractsResult.proxy.proxyAddress}, insufficient ETH balance.`
      );
    }
    */

    const entrypointABI = await getEntryPointABI();
    const entrypointContract = new ethers.Contract(
      networkConfig.contracts.entryPoint,
      entrypointABI,
      setupContractsResult.backendSigner
    );

    const ensurePaymasterPrefundResult = await ensurePaymasterHasEnoughEth(
      networkConfig.balances,
      entrypointContract,
      networkConfig.contracts.paymasterAddress!,
      setupContractsResult.provider
    );
    if (!ensurePaymasterPrefundResult) {
      throw new Error(`Cannot make the transaction right now. Please try again later.`);
    }

    return { success: true, setupContractsResult, entryPointContract: entrypointContract };
  } catch (error: unknown) {
    Logger.error('checkBlockchainConditions', `${error}`);
    return { success: false, setupContractsResult: null, entryPointContract: null };
  }
}

/**
 * Checks whether a user has reached or exceeded the allowed daily operation limit
 * for a specific operation type on the provided blockchain network.
 *
 * @param networkConfig - Blockchain network configuration containing the chainId.
 * @param phoneNumber - User's phone number identifier.
 * @param operationType - Type of operation being performed ('transfer', 'swap', 'mint_nft', 'mint_nft_copy').
 * @param limitUnit - Limit Unit
 *
 * @returns `true` if the user has reached or exceeded the daily operation limit; otherwise, `false`.
 */
export async function userReachedOperationLimit(
  networkConfig: IBlockchain,
  phoneNumber: string,
  operationType: 'transfer' | 'swap' | 'mint_nft' | 'mint_nft_copy',
  limitUnit: 'D' = 'D'
): Promise<boolean> {
  const currentDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  try {
    const blockchain: IBlockchain | null = await mongoBlockchainService.getBlockchain(
      networkConfig.chainId
    );

    if (!blockchain) {
      Logger.error(
        'checkUserOperationLimit',
        `blockchain not found for chainId: ${networkConfig.chainId}`
      );
      return false;
    }

    const user = await UserModel.findOne({ phone_number: phoneNumber }).lean();

    if (!user) {
      Logger.error('checkUserOperationLimit', `User not found: ${phoneNumber}`);
      return false;
    }

    if (!blockchain.limits) {
      Logger.error(
        'checkUserOperationLimit',
        `Limits configuration not found for blockchain ${blockchain.name}`
      );
      return false;
    }

    const userLevel = (user.level || 'L1').toUpperCase() as keyof BlockchainOperationLimits;
    const limitForOp = blockchain.limits[operationType]?.[userLevel];

    if (!limitForOp) {
      Logger.error(
        'checkUserOperationLimit',
        `Limit configuration missing for ${operationType} at level ${userLevel}`
      );
      return false;
    }

    const currentCount = user.operations_counters?.[operationType]?.[currentDate] || 0;
    const limit = limitForOp[limitUnit];

    Logger.info(
      'checkUserOperationLimit',
      `User: ${phoneNumber}, Operation: ${operationType}, Date: ${currentDate}, Count: ${currentCount}, Limit: ${limit}`
    );

    return currentCount >= limit;
  } catch (error) {
    Logger.error(
      'checkUserOperationLimit',
      `Error validating limits for ${operationType}`,
      (error as Error).message
    );
    return false;
  }
}

/**
 * Checks if a user is within the operation limits for a given token (e.g., 'transfer', 'swap') and chain.
 *
 * @param phoneNumber - User's phone number identifier.
 * @param operationType - Type of operation being performed (e.g., 'transfer', 'swap').
 * @param tokenSymbol - The token symbol (e.g., 'USDT', 'WETH').
 * @param chainId - The blockchain network's chainId (e.g., 1 for Ethereum).
 * @param amount - The amount the user wants to transfer or swap.
 *
 * @returns An object containing a boolean `isWithinLimits` and the `min` and `max` limits if available.
 */
export async function userWithinTokenOperationLimits(
  phoneNumber: string,
  operationType: 'transfer' | 'swap',
  tokenSymbol: string,
  chainId: number,
  amount: number
): Promise<{ isWithinLimits: boolean; min?: number; max?: number }> {
  try {
    // Fetch the token configuration based on token symbol and chain_id
    const token = await Token.findOne({
      symbol: tokenSymbol,
      chain_id: chainId
    });

    if (!token) {
      Logger.error(
        'userWithinTokenOperationLimits',
        `Token with symbol ${tokenSymbol} not found for chainId: ${chainId}`
      );
      return { isWithinLimits: false };
    }

    // Get the operation limits for the token
    const operationLimits = token.operations_limits;
    if (!operationLimits) {
      Logger.error(
        'userWithinTokenOperationLimits',
        `No operation limits found for token: ${tokenSymbol}`
      );
      return { isWithinLimits: false };
    }

    // Fetch the user's level dynamically from the UserModel
    const user = await UserModel.findOne({ phone_number: phoneNumber }).lean();
    if (!user) {
      Logger.error(
        'userWithinTokenOperationLimits',
        `User not found for phone number: ${phoneNumber}`
      );
      return { isWithinLimits: false };
    }

    const userLevel = (user.level || 'L1').toUpperCase() as keyof TokenOperationLimits;
    const limits = operationLimits[operationType]?.[userLevel];

    if (!limits) {
      Logger.error(
        'userWithinTokenOperationLimits',
        `No limits found for ${operationType} at user level ${userLevel} for token ${tokenSymbol} and chain ${chainId}`
      );
      return { isWithinLimits: false };
    }

    const { min, max } = limits;

    // Check if the amount is within the allowed limits
    if (amount < min || amount > max) {
      Logger.warn(
        'userWithinTokenOperationLimits',
        `Amount ${amount} for token ${tokenSymbol} is out of bounds. Min: ${min}, Max: ${max}`
      );
      return { isWithinLimits: false, min, max };
    }

    // If the amount is within limits, return true with min and max values
    Logger.info(
      'userWithinTokenOperationLimits',
      `User: ${phoneNumber}, Operation: ${operationType}, Token: ${tokenSymbol}, Amount: ${amount}, Limits: Min: ${min}, Max: ${max}`
    );
    return { isWithinLimits: true, min, max };
  } catch (error) {
    Logger.error(
      'userWithinTokenOperationLimits',
      `Error validating operation limits for token: ${tokenSymbol}`,
      (error as Error).message
    );
    return { isWithinLimits: false };
  }
}
