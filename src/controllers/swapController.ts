import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import Transaction from '../models/transaction';
import { executeSwap } from '../services/swapService';
import { SIGNING_KEY } from '../constants/environment';
import { SIMPLE_SWAP_ADDRESS } from '../constants/blockchain';
import { setupERC20 } from '../services/contractSetupService';
import { returnErrorResponse } from '../utils/responseFormatter';
import { sendSwapNotification } from '../services/notificationService';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { TokenAddresses, getTokensAddresses } from '../services/blockchainService';

interface SwapBody {
  channel_user_id: string;
  user_wallet: string;
  inputCurrency: string;
  outputCurrency: string;
  amount: number;
}

/**
 * Validates the input for the swap operation.
 */
const validateInputs = async (
  inputs: SwapBody,
  tokenAddresses: TokenAddresses
): Promise<string> => {
  const { channel_user_id, inputCurrency, outputCurrency, amount } = inputs;

  if (!channel_user_id || !inputCurrency || !outputCurrency) {
    return 'Missing required fields: address, inputCurrency, or outputCurrency';
  }

  if (channel_user_id.length > 15) {
    return 'Invalid Phone Number';
  }

  if (inputCurrency === outputCurrency) {
    return 'Input and output currencies must be different';
  }

  if (amount === undefined || amount <= 0) {
    return 'Amount must be provided and greater than 0';
  }

  if (!tokenAddresses.tokenAddressInput || !tokenAddresses.tokenAddressOutput) {
    return 'Invalid token symbols for the current network';
  }

  return '';
};

/**
 * Saves the transaction details to the database.
 */
async function saveTransaction(
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

/**
 * Handles the swap operation.
 */
export const swap = async (request: FastifyRequest<{ Body: SwapBody }>, reply: FastifyReply) => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

    const { tokens: blockchainTokensFromFastify, networkConfig: blockchainConfigFromFastify } =
      request.server as FastifyInstance;

    const tokenAddresses: TokenAddresses = getTokensAddresses(
      blockchainConfigFromFastify,
      blockchainTokensFromFastify,
      inputCurrency,
      outputCurrency
    );

    const validationError: string = await validateInputs(request.body, tokenAddresses);

    if (validationError) {
      return await reply.status(400).send({ message: validationError });
    }

    const provider = new ethers.providers.JsonRpcProvider(blockchainConfigFromFastify.rpc);
    const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
    const { proxyAddress } = await computeProxyAddressFromPhone(channel_user_id);

    // Get the contracts and decimals for the tokens
    const fromTokenContract = await setupERC20(tokenAddresses.tokenAddressInput, backendSigner);
    const fromTokenDecimals = await fromTokenContract.decimals();

    const toTokenContract = await setupERC20(tokenAddresses.tokenAddressOutput, backendSigner);
    const toTokenDecimals = await toTokenContract.decimals();

    // Get the current balances before the transaction
    const fromTokenCurrentBalance = await fromTokenContract.balanceOf(proxyAddress);
    const toTokenCurrentBalance = await toTokenContract.balanceOf(proxyAddress);

    const amountToCheck = ethers.utils.parseUnits(amount.toString(), fromTokenDecimals);
    const enoughBalance: boolean = fromTokenCurrentBalance.gte(amountToCheck);

    if (!enoughBalance) {
      return await returnErrorResponse(reply, 400, 'Insufficient balance to make the swap');
    }

    // Send initial response to client
    reply
      .status(200)
      .send({ message: 'Currency exchange in progress, it may take a few minutes.' });

    // Determine swap direction
    const isWETHtoUSDT =
      inputCurrency.toUpperCase() === 'WETH' && outputCurrency.toUpperCase() === 'USDT';

    // Execute the swap with the SimpleSwap contract
    // The SimpleSwap contract makes sense for performing swaps of WETH for USDT and vice versa.
    // This type of contract works similarly to a basic Automated Market Maker (AMM), where the
    // liquidity reserve is used to determine the exchange rate between the two tokens.
    // In this case, when you call the swapWETHforUSDT function, the contract uses the amount of WETH
    // you wish to swap and the current WETH and USDT reserves to calculate how many USDT you will receive.
    const tx = await executeSwap(
      request.server,
      channel_user_id,
      tokenAddresses,
      amount.toString(),
      request.server.networkConfig.chain_id,
      isWETHtoUSDT
    );

    // Get the new balances after the transaction
    const fromTokenNewBalance = await fromTokenContract.balanceOf(proxyAddress);
    const toTokenNewBalance = await toTokenContract.balanceOf(proxyAddress);

    // Calculate the tokens sent and received, considering the correct decimals
    const fromTokensSent = fromTokenCurrentBalance.sub(fromTokenNewBalance);
    const toTokensReceived = toTokenNewBalance.sub(toTokenCurrentBalance);

    // Ensure the values are in the correct units (converted to 'number' for saveTransaction)
    const fromTokensSentInUnits = parseFloat(
      ethers.utils.formatUnits(fromTokensSent, fromTokenDecimals)
    );
    const toTokensReceivedInUnits = parseFloat(
      ethers.utils.formatUnits(toTokensReceived, toTokenDecimals)
    );

    // Send notifications
    await sendSwapNotification(
      channel_user_id,
      inputCurrency,
      fromTokensSentInUnits.toString(),
      toTokensReceivedInUnits.toString(),
      outputCurrency,
      tx.swapTransactionHash
    );

    // Save transactions OUT
    await saveTransaction(
      tx.approveTransactionHash,
      proxyAddress,
      SIMPLE_SWAP_ADDRESS,
      fromTokensSentInUnits,
      inputCurrency
    );

    // Save transactions IN
    await saveTransaction(
      tx.swapTransactionHash,
      SIMPLE_SWAP_ADDRESS,
      proxyAddress,
      toTokensReceivedInUnits,
      outputCurrency
    );

    console.info(
      `Swap completed successfully approveTransactionHash: ${tx.approveTransactionHash}, swapTransactionHash: ${tx.swapTransactionHash}.`
    );
    return true;
  } catch (error) {
    console.error('Error swapping tokens:', error);
    return reply.status(500).send({ message: 'Internal Server Error' });
  }
};
