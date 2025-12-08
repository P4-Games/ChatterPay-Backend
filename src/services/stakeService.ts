/* eslint-disable no-restricted-syntax */
import { ethers } from 'ethers';

import { Logger } from '../helpers/loggerHelper';
import { IBlockchain } from '../models/blockchainModel';
import { IUser, IUserWallet } from '../models/userModel';
import { setupERC20 } from './web3/contractSetupService';
import { mongoUserService } from './mongo/mongoUserService';
import { checkBlockchainConditions } from './blockchainService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import {
  createExecuteCallData,
  executeUserOperationWithRetry
} from './web3/userOpService';
import {
  logPaymasterEntryPointDeposit,
  getPaymasterEntryPointDepositValue
} from './web3/paymasterService';
import {
  openOperation,
  closeOperation,
  getUserWalletByChainId,
  hasUserAnyOperationInProgress
} from './userService';
import {
  ConcurrentOperationsEnum,
  CheckBalanceConditionsResult,
  ExecueTransactionResult
} from '../types/commonType';
import { STAKED_USX_CONTRACT_ADDRESS } from '../config/constants';
import StakedUSXABI from './web3/abis/StakedUSX.sol/StakedUSX.json';

interface StakingStrategy {
  contractAddress: string;
  abi: any;
  tokenSymbol: string;
}

const STAKING_CONFIG: Record<string, StakingStrategy> = {
  USX: {
    contractAddress: STAKED_USX_CONTRACT_ADDRESS,
    abi: StakedUSXABI.abi,
    tokenSymbol: 'USX'
  }
};

/**
 * Sends a user operation for staking tokens.
 *
 * @param networkConfig
 * @param setupContractsResult
 * @param entryPointContract
 * @param userWalletAddress
 * @param amount
 * @param strategy
 * @param logKey
 * @returns
 */
async function sendStakeUserOperation(
  networkConfig: IBlockchain,
  setupContractsResult: any,
  entryPointContract: ethers.Contract,
  userWalletAddress: string,
  amount: string,
  strategy: StakingStrategy,
  logKey: string
): Promise<ExecueTransactionResult> {
  try {
    const { userPrincipal, chatterPay, proxy, provider } = setupContractsResult;

    // 1. Initialize Staking Contract
    const stakingInterface = new ethers.utils.Interface(strategy.abi);
    const stakingContract = new ethers.Contract(strategy.contractAddress, strategy.abi, provider);

    // 2. Get Asset Config (assuming ERC4626 standard asset() function)
    const assetAddress = await stakingContract.asset();
    const assetContract = await setupERC20(assetAddress, userPrincipal);
    const decimals = await assetContract.decimals();
    const amountBN = ethers.utils.parseUnits(amount, decimals);

    // 3. Check Allowance
    const allowance = await assetContract.allowance(userWalletAddress, strategy.contractAddress);
    if (allowance.lt(amountBN)) {
      Logger.info('sendStakeUserOperation', logKey, 'Insufficient allowance, approving...');
      // Execute Approve UserOp
      const approveCallData = chatterPay.interface.encodeFunctionData('approveToken', [
        assetAddress,
        ethers.constants.MaxUint256
      ]);

      const userOpGasConfig = networkConfig.gas.operations.stake;
      const approveResult = await executeUserOperationWithRetry(
        networkConfig,
        provider,
        userPrincipal,
        entryPointContract,
        approveCallData,
        proxy.proxyAddress,
        'stake',
        logKey + '-approve',
        userOpGasConfig.perGasInitialMultiplier,
        userOpGasConfig.perGasIncrement,
        userOpGasConfig.callDataInitialMultiplier,
        userOpGasConfig.maxRetries,
        userOpGasConfig.timeoutMsBetweenRetries
      );

      if (!approveResult.success) {
        throw new Error(`Approval failed: ${approveResult.error}`);
      }
      Logger.info('sendStakeUserOperation', logKey, `Approval successful: ${approveResult.transactionHash}`);
    }

    // 4. Create Deposit Call Data
    // ERC4626: deposit(uint256 assets, address receiver)
    const depositCallData = stakingInterface.encodeFunctionData('deposit', [
      amountBN,
      userWalletAddress
    ]);

    // 5. Create Execute Call Data for Wallet
    const executeCallData = await createExecuteCallData(
      chatterPay,
      strategy.contractAddress,
      ethers.BigNumber.from(0),
      depositCallData
    );

    // 6. Execute UserOp
    const userOpGasConfig = networkConfig.gas.operations.stake;
    const userOpResult = await executeUserOperationWithRetry(
      networkConfig,
      provider,
      userPrincipal,
      entryPointContract,
      executeCallData,
      proxy.proxyAddress,
      'stake',
      logKey,
      userOpGasConfig.perGasInitialMultiplier,
      userOpGasConfig.perGasIncrement,
      userOpGasConfig.callDataInitialMultiplier,
      userOpGasConfig.maxRetries,
      userOpGasConfig.timeoutMsBetweenRetries
    );

    return userOpResult;

  } catch (error) {
    const errorMessage = JSON.stringify(error);
    Logger.error(
      'sendStakeUserOperation',
      `Error, amount: ${amount}, error: `,
      errorMessage
    );
    return { success: false, transactionHash: '', error: errorMessage };
  }
}

/**
 * Sends a user operation for unstaking tokens.
 *
 * @param networkConfig
 * @param setupContractsResult
 * @param entryPointContract
 * @param userWalletAddress
 * @param amount
 * @param strategy
 * @param logKey
 * @returns
 */
async function sendUnstakeUserOperation(
  networkConfig: IBlockchain,
  setupContractsResult: any,
  entryPointContract: ethers.Contract,
  userWalletAddress: string,
  amount: string,
  strategy: StakingStrategy,
  logKey: string
): Promise<ExecueTransactionResult> {
  try {
    const { userPrincipal, chatterPay, proxy, provider } = setupContractsResult;

    // 1. Initialize Staking Contract
    const stakingInterface = new ethers.utils.Interface(strategy.abi);
    const stakingContract = new ethers.Contract(strategy.contractAddress, strategy.abi, provider);

    // 2. Get Asset details for decimals
    const assetAddress = await stakingContract.asset();
    const assetContract = await setupERC20(assetAddress, userPrincipal);
    const decimals = await assetContract.decimals();
    const amountBN = ethers.utils.parseUnits(amount, decimals);

    // 3. Create Withdraw Call Data
    // ERC4626: withdraw(uint256 assets, address receiver, address owner)
    const withdrawCallData = stakingInterface.encodeFunctionData('withdraw', [
      amountBN,
      userWalletAddress, // receiver
      userWalletAddress  // owner
    ]);

    // 4. Create Execute Call Data for Wallet
    const executeCallData = await createExecuteCallData(
      chatterPay,
      strategy.contractAddress,
      ethers.BigNumber.from(0),
      withdrawCallData
    );

    // 5. Execute UserOp (using unstake gas config)
    const userOpGasConfig = networkConfig.gas.operations.unstake;
    const userOpResult = await executeUserOperationWithRetry(
      networkConfig,
      provider,
      userPrincipal,
      entryPointContract,
      executeCallData,
      proxy.proxyAddress,
      'unstake',
      logKey,
      userOpGasConfig.perGasInitialMultiplier,
      userOpGasConfig.perGasIncrement,
      userOpGasConfig.callDataInitialMultiplier,
      userOpGasConfig.maxRetries,
      userOpGasConfig.timeoutMsBetweenRetries
    );

    return userOpResult;

  } catch (error) {
    const errorMessage = JSON.stringify(error);
    Logger.error(
      'sendUnstakeUserOperation',
      `Error, amount: ${amount}, error: `,
      errorMessage
    );
    return { success: false, transactionHash: '', error: errorMessage };
  }
}

export async function processStakeRequest(
  channel_user_id: string,
  amount: string,
  chain_id: number,
  type: 'stake' | 'unstake',
  tokenSymbol: string,
  logKey: string
): Promise<{ result: boolean; message: string; transactionHash?: string }> {
  try {
    // Validate Token Strategy
    const strategy = STAKING_CONFIG[tokenSymbol];
    if (!strategy) {
      return { result: false, message: `Staking not supported for token: ${tokenSymbol}` };
    }

    const bddUser: IUser | null = await mongoUserService.getUser(channel_user_id);
    if (!bddUser) {
      return { result: false, message: 'User not found' };
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      bddUser.wallets,
      chain_id
    );
    if (!userWallet) {
      return { result: false, message: `No wallet found for chain ${chain_id}` };
    }

    if (hasUserAnyOperationInProgress(bddUser)) {
      return {
        result: false,
        message: `Concurrent operation in progress for wallet ${userWallet.wallet_proxy}`
      };
    }

    // Check Blockchain Conditions
    const networkConfig = await mongoBlockchainService.getNetworkConfig(chain_id);
    if (!networkConfig) {
      return { result: false, message: 'Blockchain not configured' };
    }

    const checkResult: CheckBalanceConditionsResult = await checkBlockchainConditions(networkConfig, bddUser);

    if (!checkResult.success) {
      return { result: false, message: 'Invalid Blockchain Conditions' };
    }

    await openOperation(bddUser.phone_number, ConcurrentOperationsEnum.Transfer);

    let executeResult: ExecueTransactionResult;
    
    // Keep Paymaster Deposit Value
    const paymasterDepositValuePrev = await getPaymasterEntryPointDepositValue(
      checkResult.entryPointContract!,
      networkConfig.contracts.paymasterAddress!
    );

    if (type === 'stake') {
      executeResult = await sendStakeUserOperation(
        networkConfig,
        checkResult.setupContractsResult!,
        checkResult.entryPointContract!,
        userWallet.wallet_proxy,
        amount,
        strategy,
        logKey
      );
    } else {
      executeResult = await sendUnstakeUserOperation(
        networkConfig,
        checkResult.setupContractsResult!,
        checkResult.entryPointContract!,
        userWallet.wallet_proxy,
        amount,
        strategy,
        logKey
      );
    }

    await logPaymasterEntryPointDeposit(
      checkResult.entryPointContract!,
      networkConfig.contracts.paymasterAddress!,
      paymasterDepositValuePrev
    );

    if (executeResult.success) {
      // Save transaction
      await mongoTransactionService.saveTransaction({
        tx: executeResult.transactionHash,
        walletFrom: userWallet.wallet_proxy,
        walletTo: strategy.contractAddress,
        amount: parseFloat(amount),
        fee: 0,
        token: strategy.tokenSymbol,
        type: type,
        status: 'completed',
        chain_id: chain_id
      });
    }

    await closeOperation(channel_user_id, ConcurrentOperationsEnum.Transfer);

    if (executeResult.success) {
        return { result: true, message: '', transactionHash: executeResult.transactionHash };
    } else {
        return { result: false, message: executeResult.error };
    }

  } catch (error: any) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.Transfer);
    return { result: false, message: error.message };
  }
}
