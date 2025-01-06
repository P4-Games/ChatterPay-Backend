import { ethers } from 'ethers';

import { Logger } from '../utils/logger';
import Transaction from '../models/transaction';
import { TokenAddresses } from '../types/common';
import { IBlockchain } from '../models/blockchain';
import { addPaymasterData } from './paymasterService';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { setupERC20, setupContractReturnType } from './contractSetupService';
import { signUserOperation, createGenericUserOperation } from './userOperationService';

/**
 * Creates callData for token approval
 */
function createApproveCallData(
  chatterPayContract: ethers.Contract,
  tokenContract: ethers.Contract,
  spender: string,
  amount: string
): string {
  const amount_bn = ethers.utils.parseUnits(amount, 18);
  const approveEncode = tokenContract.interface.encodeFunctionData('approve', [spender, amount_bn]);
  Logger.log('Approve Encode:', approveEncode);

  const callData = chatterPayContract.interface.encodeFunctionData('execute', [
    tokenContract.address,
    0,
    approveEncode
  ]);
  Logger.log('Approve Call Data:', callData);

  return callData;
}

/**
 * Creates callData for swap execution
 */
function createSwapCallData(
  chatterPayContract: ethers.Contract,
  swapContract: ethers.Contract,
  isWETHtoUSDT: boolean,
  amount: string
): string {
  const amount_bn = ethers.utils.parseUnits(amount, 18);
  const swapEncode = swapContract.interface.encodeFunctionData(
    isWETHtoUSDT ? 'swapWETHforUSDT' : 'swapUSDTforWETH',
    [amount_bn]
  );
  Logger.log('Swap Encode:', swapEncode);

  const callData = chatterPayContract.interface.encodeFunctionData('execute', [
    swapContract.address,
    0,
    swapEncode
  ]);
  Logger.log('Swap Call Data:', callData);

  return callData;
}

/**
 * Executes a user operation with the given callData
 */
async function executeOperation(
  networkConfig: IBlockchain,
  callData: string,
  signer: ethers.Wallet,
  backendSigner: ethers.Wallet, // Agregamos backendSigner como parámetro
  entrypointContract: ethers.Contract,
  bundlerUrl: string,
  proxyAddress: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<string> {
  // Get the nonce
  const nonce = await entrypointContract.getNonce(proxyAddress, 0);
  Logger.log('Nonce:', nonce.toString());

  // Create the base user operation
  let userOperation = await createGenericUserOperation(callData, proxyAddress, nonce);

  // Add paymaster data - Usamos el backendSigner que recibimos como parámetro
  userOperation = await addPaymasterData(
    userOperation,
    networkConfig.contracts.paymasterAddress!,
    backendSigner
  );

  // Sign the user operation
  userOperation = await signUserOperation(
    userOperation,
    networkConfig.contracts.entryPoint,
    signer
  );

  // Send to bundler
  const bundlerResponse = await sendUserOperationToBundler(
    bundlerUrl,
    userOperation,
    entrypointContract.address
  );

  // Wait for receipt
  const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
  if (!receipt?.success) {
    Logger.error('receipt', receipt);
    throw new Error(
      `Transaction failed or not found, receipt: ${receipt.success}, ${receipt.userOpHash}`
    );
  }

  return receipt.receipt.transactionHash;
}

/**
 * Execute the swap with the SimpleSwap contract
 *
 * The SimpleSwap contract makes sense for performing swaps of WETH for USDT and vice versa.
 * This type of contract works similarly to a basic Automated Market Maker (AMM), where the
 * liquidity reserve is used to determine the exchange rate between the two tokens.
 * In this case, when you call the swapWETHforUSDT function, the contract uses the amount of WETH
 * you wish to swap and the current WETH and USDT reserves to calculate how many USDT you will receive.
 *
 * @param networkConfig
 * @param tokenAddresses
 * @param amount
 * @returns
 */
export async function executeSwap(
  networkConfig: IBlockchain,
  setupContractsResult: setupContractReturnType,
  entryPointContract: ethers.Contract,
  tokenAddresses: TokenAddresses,
  amount: string
): Promise<{ success: boolean; approveTransactionHash: string; swapTransactionHash: string }> {
  try {
    const isWETHtoUSDT =
      tokenAddresses.tokenAddressInput.toUpperCase() === 'WETH' &&
      tokenAddresses.tokenAddressOutput.toUpperCase() === 'USDT';

    // Create SimpleSwap contract instance
    const simpleSwapContract = new ethers.Contract(
      networkConfig.contracts.simpleSwapAddress,
      [
        'function swapWETHforUSDT(uint256 wethAmount) external',
        'function swapUSDTforWETH(uint256 usdtAmount) external'
      ],
      setupContractsResult.provider
    );

    // 1. Execute approve operation
    Logger.log('Swap: Executing approve operation.');
    const erc20 = await setupERC20(tokenAddresses.tokenAddressInput, setupContractsResult.signer);
    const approveCallData = createApproveCallData(
      setupContractsResult.chatterPay,
      erc20,
      networkConfig.contracts.simpleSwapAddress,
      amount
    );

    const approveHash = await executeOperation(
      networkConfig,
      approveCallData,
      setupContractsResult.signer,
      setupContractsResult.backendSigner,
      entryPointContract,
      setupContractsResult.bundlerUrl,
      setupContractsResult.proxy.proxyAddress,
      setupContractsResult.provider
    );

    // 2. Execute swap operation
    Logger.log('Swap: Executing swap operation.');
    const swapCallData = createSwapCallData(
      setupContractsResult.chatterPay,
      simpleSwapContract,
      isWETHtoUSDT,
      amount
    );

    const swapHash = await executeOperation(
      networkConfig,
      swapCallData,
      setupContractsResult.signer,
      setupContractsResult.backendSigner,
      entryPointContract,
      setupContractsResult.bundlerUrl,
      setupContractsResult.proxy.proxyAddress,
      setupContractsResult.provider
    );

    return {
      success: true,
      approveTransactionHash: approveHash,
      swapTransactionHash: swapHash
    };
  } catch (error) {
    Logger.error('Error in executeSwap:', error);
    return { success: false, approveTransactionHash: '', swapTransactionHash: '' };
  }
}

/**
 * Saves the transaction details to the database.
 */
export async function saveSwapTransaction(
  tx: string,
  walletFrom: string,
  walletTo: string,
  amount: number,
  currency: string
) {
  await Transaction.create({
    trx_hash: tx,
    wallet_from: walletFrom,
    wallet_to: walletTo,
    type: 'transfer',
    date: new Date(),
    status: 'completed',
    amount,
    token: currency
  });
}
