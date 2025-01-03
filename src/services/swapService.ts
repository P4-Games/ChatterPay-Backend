import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import { Logger } from '../utils/logger';
import { getEntryPointABI } from './bucketService';
import { verifyWalletBalance } from './walletService';
import { ensureSignerHasEth } from './transferService';
import { generatePrivateKey } from '../utils/keyGenerator';
import { SIMPLE_SWAP_ADDRESS } from '../constants/blockchain';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from '../utils/waitForTX';
import { getBlockchain, TokenAddresses } from './blockchainService';
import { setupERC20, setupContracts } from './contractSetupService';
import { addPaymasterData, ensurePaymasterHasPrefund } from './paymasterService';
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
      throw new Error('Seed private key not found in environment variables');
    }

    const privateKey = generatePrivateKey(seedPrivateKey, fromNumber);
    const { provider, signer, backendSigner, bundlerUrl, chatterPay, proxy, accountExists } =
      await setupContracts(blockchain, privateKey, fromNumber);
    const erc20 = await setupERC20(tokenAddresses.tokenAddressInput, signer);
    Logger.log('Contracts and signers set up.', signer.address);

    const checkBalanceResult = await verifyWalletBalance(erc20, proxy.proxyAddress, amount);
    if (!checkBalanceResult.enoughBalance) {
      throw new Error(
        `Insufficient balance. Required: ${checkBalanceResult.amountToCheck}, Available: ${checkBalanceResult.walletBalance}`
      );
    }
    Logger.log('Balance check passed');

    await ensureSignerHasEth(signer, backendSigner, provider);
    Logger.log('Signer has enough ETH');

    const { networkConfig } = fastify;
    const entrypointABI = await getEntryPointABI();
    const entrypointContract = new ethers.Contract(
      networkConfig.contracts.entryPoint,
      entrypointABI,
      backendSigner
    );

    await ensurePaymasterHasPrefund(entrypointContract, networkConfig.contracts.paymasterAddress!);

    Logger.log('Validating account');
    if (!accountExists) {
      throw new Error(`Account ${proxy.proxyAddress} does not exist`);
    }

    // Create SimpleSwap contract instance
    const simpleSwapContract = new ethers.Contract(
      SIMPLE_SWAP_ADDRESS,
      [
        'function swapWETHforUSDT(uint256 wethAmount) external',
        'function swapUSDTforWETH(uint256 usdtAmount) external'
      ],
      provider
    );

    // 1. Execute approve operation
    Logger.log('Executing approve operation.');
    const approveCallData = createApproveCallData(chatterPay, erc20, SIMPLE_SWAP_ADDRESS, amount);

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
