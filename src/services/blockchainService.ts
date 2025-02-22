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
import {
  USER_SIGNER_MIN_BALANCE,
  BACKEND_SIGNER_MIN_BALANCE,
  USER_SIGNER_BALANCE_TO_TRANSFER
} from '../config/constants';

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
    (token) => token.chain_id === blockchainConfig.chain_id
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
      'ensureBackendSignerHasEnoughEth',
      `Checking if Backend Signer ${backendSignerWalletAddress} has minimal funds (${BACKEND_SIGNER_MIN_BALANCE}) to make transactions.`
    );

    const walletBalance = await provider.getBalance(backendSignerWalletAddress);
    const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);
    Logger.log(
      'ensureBackendSignerHasEnoughEth',
      `Backend Signer ${backendSignerWalletAddress} balance: ${walletBalanceFormatted} ETH.`
    );

    if (walletBalance.lt(ethers.utils.parseEther(BACKEND_SIGNER_MIN_BALANCE))) {
      Logger.error(
        'ensureBackendSignerHasEnoughEth',
        `Backend Signer ${backendSignerWalletAddress} current balance: ${walletBalanceFormatted} ETH, ` +
          `balance required: ${BACKEND_SIGNER_MIN_BALANCE} ETH.`
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
  userSignerWalletAdddress: string,
  backendSignerWallet: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
): Promise<boolean> {
  try {
    const backendSignerWalletAddress = await backendSignerWallet.getAddress();
    Logger.log(
      'ensureUserSignerHasEnoughEth',
      `Checking if User EOA ${userSignerWalletAdddress} has minimal funds (${USER_SIGNER_MIN_BALANCE}) to sign the transaction.`
    );

    const EOABalance = await provider.getBalance(userSignerWalletAdddress);
    Logger.log(
      'ensureUserSignerHasEnoughEth',
      `User EOA ${userSignerWalletAdddress} balance: ${ethers.utils.formatEther(EOABalance)} ETH.`
    );

    if (EOABalance.lt(ethers.utils.parseEther(USER_SIGNER_MIN_BALANCE))) {
      Logger.log(
        'ensureUserSignerHasEnoughEth',
        `Sending ${USER_SIGNER_BALANCE_TO_TRANSFER} ETH from backendSigner ${backendSignerWalletAddress} ` +
          `to User EOA ${userSignerWalletAdddress}.`
      );

      const tx = await backendSignerWallet.sendTransaction({
        to: userSignerWalletAdddress,
        value: ethers.utils.parseEther(USER_SIGNER_BALANCE_TO_TRANSFER),
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
      networkConfig.chain_id
    );

    if (!blockchain) {
      throw new Error(`Blockchain with chain_id ${networkConfig.chain_id} not found`);
    }

    const privateKey = generatePrivateKey(fromNumber, networkConfig.chain_id.toString());
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
