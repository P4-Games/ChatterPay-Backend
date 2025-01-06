import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../utils/logger';
import { SIGNING_KEY } from '../constants/environment';
import { setupERC20 } from '../services/contractSetupService';
import { CheckBalanceConditionsResultType } from '../types/common';
import { executeSwap, saveSwapTransaction } from '../services/swapService';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';
import {
  TokenAddresses,
  getTokensAddresses,
  checkBlockchainConditions
} from '../services/blockchainService';
import {
  sendSwapNotification,
  sendUserInsufficientBalanceNotification,
  sendNoValidBlockchainConditionsNotification
} from '../services/notificationService';

interface SwapBody {
  channel_user_id: string;
  user_wallet: string;
  inputCurrency: string;
  outputCurrency: string;
  amount: number;
}

/**
 * Validates the input for the swap operation.
 *
 * @param inputs
 * @param tokenAddresses
 * @returns
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
 * Handles the swap operation.
 *
 * @param request
 * @param reply
 * @returns
 */
// eslint-disable-next-line consistent-return
export const swap = async (request: FastifyRequest<{ Body: SwapBody }>, reply: FastifyReply) => {
  try {
    /* ***************************************************** */
    /* 1. swap: input params                                 */
    /* ***************************************************** */
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, inputCurrency, outputCurrency, amount } = request.body;

    const { tokens: blockchainTokens, networkConfig } = request.server as FastifyInstance;

    const tokenAddresses: TokenAddresses = getTokensAddresses(
      networkConfig,
      blockchainTokens,
      inputCurrency,
      outputCurrency
    );

    const validationError: string = await validateInputs(request.body, tokenAddresses);

    if (validationError) {
      return await returnErrorResponse(reply, 400, validationError);
    }

    /* ***************************************************** */
    /* 2. swap: send initial response                        */
    /* ***************************************************** */
    await returnSuccessResponse(reply, 'Swap in progress, it may take a few minutes.');
    // await reply.status(200).send({ message: 'Swap in progress, it may take a few minutes.' });

    /* ***************************************************** */
    /* 3. swap: check user balance                           */
    /* ***************************************************** */

    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
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
      sendUserInsufficientBalanceNotification(proxyAddress, channel_user_id);
      return undefined;
    }

    /* ***************************************************** */
    /* 4. swap: check blockchain conditions                  */
    /* ***************************************************** */

    // 4. swap: check blockchain conditions
    const checkBlockchainConditionsResult: CheckBalanceConditionsResultType =
      await checkBlockchainConditions(networkConfig, channel_user_id);

    if (!checkBlockchainConditionsResult.success) {
      sendNoValidBlockchainConditionsNotification(proxyAddress, channel_user_id);
      return undefined;
    }

    /* ***************************************************** */
    /* 5. swap: save transaciton with pending status         */
    /* ***************************************************** */

    // TODO: swap: save transaciton with pending status

    /* ***************************************************** */
    /* 6. swap: make operation                               */
    /* ***************************************************** */

    const tx = await executeSwap(
      networkConfig,
      checkBlockchainConditionsResult.setupContractsResult!,
      checkBlockchainConditionsResult.entryPointContract!,
      tokenAddresses,
      amount.toString()
    );

    /* ***************************************************** */
    /* 7. swap: send notificaiton to user                    */
    /* ***************************************************** */

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

    /* ***************************************************** */
    /* 8. swap: swap: update bdd with result                 */
    /* ***************************************************** */

    // Save transactions OUT
    await saveSwapTransaction(
      tx.approveTransactionHash,
      proxyAddress,
      networkConfig.contracts.simpleSwapAddress,
      fromTokensSentInUnits,
      inputCurrency
    );

    // Save transactions IN
    await saveSwapTransaction(
      tx.swapTransactionHash,
      networkConfig.contracts.simpleSwapAddress,
      proxyAddress,
      toTokensReceivedInUnits,
      outputCurrency
    );

    Logger.info(
      `Swap completed successfully approveTransactionHash: ${tx.approveTransactionHash}, swapTransactionHash: ${tx.swapTransactionHash}.`
    );
  } catch (error) {
    Logger.error('Error swapping tokens:', error);
    return returnErrorResponse(reply, 500, 'Internal Server Error');
    // return reply.status(500).send({ message: 'Internal Server Error' });
  }
};
