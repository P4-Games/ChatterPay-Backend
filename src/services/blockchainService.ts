import { ethers } from 'ethers';

import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { getEntryPointABI } from './web3/abiService';
import { IBlockchain } from '../models/blockchainModel';
import { setupContracts } from './web3/contractSetupService';
import { generatePrivateKey } from '../helpers/SecurityHelper';
import { ensurePaymasterHasEnoughEth } from './web3/paymasterService';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import {
  TokenAddresses,
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
export function getTokenAddress(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbol: string
): string {
  if (!blockchainTokens) return '';

  const chainTokens = blockchainTokens.filter(
    (token) => token.chain_id === blockchainConfig.chainId
  );

  const foundToken = chainTokens.find(
    (t) => t.symbol.toLowerCase() === lookUpTokenSymbol.toLowerCase()
  );

  return foundToken?.address ?? '';
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
export function getTokensAddresses(
  blockchainConfig: IBlockchain,
  blockchainTokens: IToken[],
  lookUpTokenSymbolInput: string,
  lookUpTokenSymbolOutput: string
): TokenAddresses {
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
    tokenAddressInput: foundTokenInput?.address ?? '',
    tokenAddressOutput: foundTokenOutput?.address ?? ''
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

      const tx = await backendSignerWallet.sendTransaction({
        to: userSignerWalletAdddress,
        value: ethers.utils.parseEther(blockchainBalances.userSignerBalanceToTransfer),
        gasLimit: 210000
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
 * Check Blockchain Conditions
 *
 * @param networkConfig
 * @param fromNumber
 * @returns
 */
export async function checkBlockchainConditions(
  networkConfig: IBlockchain,
  fromNumber: string
): Promise<CheckBalanceConditionsResult> {
  try {
    const blockchain: IBlockchain | null = await mongoBlockchainService.getBlockchain(
      networkConfig.chainId
    );

    if (!blockchain) {
      throw new Error(`Blockchain with chain_id ${networkConfig.chainId} not found`);
    }

    const privateKey = generatePrivateKey(fromNumber, networkConfig.chainId.toString());
    const setupContractsResult: SetupContractReturn = await setupContracts(
      blockchain,
      privateKey,
      fromNumber
    );

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

    const entrypointABI = await getEntryPointABI();
    const entrypointContract = new ethers.Contract(
      networkConfig.contracts.entryPoint,
      entrypointABI,
      setupContractsResult.backendSigner
    );

    const ensurePaymasterPrefundResult = await ensurePaymasterHasEnoughEth(
      networkConfig.balances,
      entrypointContract,
      networkConfig.contracts.paymasterAddress!
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
