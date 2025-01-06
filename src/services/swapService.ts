import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import { Logger } from '../utils/logger';
import { getEntryPointABI } from './bucketService';
import { verifyWalletBalance } from './walletService';
import { generatePrivateKey } from '../utils/keyGenerator';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { getBlockchain, TokenAddresses } from './blockchainService';
import { setupERC20, setupContracts } from './contractSetupService';
import { addPaymasterData, ensurePaymasterHasEnoughEth } from './paymasterService';
import { signUserOperation, createGenericUserOperation } from './userOperationService';
import { ensureUserSignerHasEnoughEth, ensureBackendSignerHasEnoughEth } from './transferService';

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
  fastify: FastifyInstance,
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
    fastify.networkConfig.contracts.paymasterAddress!,
    backendSigner
  );

  // Sign the user operation
  userOperation = await signUserOperation(
    userOperation,
    fastify.networkConfig.contracts.entryPoint,
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
    throw new Error(
      `Transaction failed or not found, receipt: ${receipt.success}, ${receipt.userOpHash}`
    );
  }

  return receipt.receipt.transactionHash;
}

/**
 * Main function to execute the swap operation
 */
export async function executeSwap(
  fastify: FastifyInstance,
  fromNumber: string,
  tokenAddresses: TokenAddresses,
  amount: string,
  chain_id: number,
  isWETHtoUSDT: boolean
): Promise<{ approveTransactionHash: string; swapTransactionHash: string }> {
  try {
    const blockchain = await getBlockchain(chain_id);
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
      throw new Error('Seed private key not found in environment variables.');
    }

    const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
    const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } =
      await setupContracts(blockchain, privateKey, fromNumber);

    Logger.log('Validating account');
    if (!accountExists) {
      throw new Error(
        `Account ${proxy.proxyAddress} does not exist. Cannot proceed with user operation.`
      );
    }

    const erc20 = await setupERC20(tokenAddresses.tokenAddressInput, signer);
    const checkUserTokenBalanceResult = await verifyWalletBalance(
      erc20,
      proxy.proxyAddress,
      amount
    );
    if (!checkUserTokenBalanceResult.enoughBalance) {
      throw new Error(
        `User Wallet ${proxy.proxyAddress}, insufficient Token balance. Required: ${checkUserTokenBalanceResult.amountToCheck}, Available: ${checkUserTokenBalanceResult.walletBalance}`
      );
    }

    const backendSignerWalletAddress = await backendSigner.getAddress();
    const checkBackendSignerBalanceresult = await ensureBackendSignerHasEnoughEth(
      backendSignerWalletAddress,
      provider
    );
    if (!checkBackendSignerBalanceresult) {
      throw new Error(
        `Backend Signer Wallet ${backendSignerWalletAddress}, insufficient ETH balance.`
      );
    }

    const userWalletAddress = await signer.getAddress();
    const checkUserEthBalanceResult = await ensureUserSignerHasEnoughEth(
      userWalletAddress,
      backendSigner,
      provider
    );
    if (!checkUserEthBalanceResult) {
      Logger.error(`User Wallet ${proxy.proxyAddress}, does not have enough ETH.`);
      throw new Error(`User Wallet ${proxy.proxyAddress}, insufficient ETH balance.`);
    }

    const { networkConfig } = fastify;
    const entrypointABI = await getEntryPointABI();
    const entrypointContract = new ethers.Contract(
      networkConfig.contracts.entryPoint,
      entrypointABI,
      backendSigner
    );

    const ensurePaymasterPrefundResult = await ensurePaymasterHasEnoughEth(
      entrypointContract,
      networkConfig.contracts.paymasterAddress!
    );
    if (!ensurePaymasterPrefundResult) {
      throw new Error(`Cannot make the transaction right now. Please try again later.`);
    }

    // Create SimpleSwap contract instance
    const simpleSwapContract = new ethers.Contract(
      networkConfig.contracts.simpleSwapAddress,
      [
        'function swapWETHforUSDT(uint256 wethAmount) external',
        'function swapUSDTforWETH(uint256 usdtAmount) external'
      ],
      provider
    );

    // 1. Execute approve operation
    Logger.log('Executing approve operation.');
    const approveCallData = createApproveCallData(
      chatterPay,
      erc20,
      networkConfig.contracts.simpleSwapAddress,
      amount
    );

    const approveHash = await executeOperation(
      fastify,
      approveCallData,
      signer,
      backendSigner,
      entrypointContract,
      bundlerUrl,
      proxy.proxyAddress,
      provider
    );

    // 2. Execute swap operation
    Logger.log('Executing swap operation.');
    const swapCallData = createSwapCallData(chatterPay, simpleSwapContract, isWETHtoUSDT, amount);

    const swapHash = await executeOperation(
      fastify,
      swapCallData,
      signer,
      backendSigner,
      entrypointContract,
      bundlerUrl,
      proxy.proxyAddress,
      provider
    );

    return {
      approveTransactionHash: approveHash,
      swapTransactionHash: swapHash
    };
  } catch (error) {
    Logger.error('Error in executeSwap:', error);
    throw error;
  }
}
