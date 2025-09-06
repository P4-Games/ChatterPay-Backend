import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/userModel';
import { aaveService } from '../services/aave/aaveService';
import { CheckBalanceConditionsResult } from '../types/commonType';
import { COMMON_REPLY_WALLET_NOT_CREATED } from '../config/constants';
import { checkBlockchainConditions } from '../services/blockchainService';
import { getUser, getUserWalletByChainId } from '../services/userService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import {
  sendAAVESuplyNotification,
  sendInternalErrorNotification,
  sendNoValidBlockchainConditionsNotification
} from '../services/notificationService';

type SupplyBody = {
  channel_user_id: string;
  amount: string;
  token: string;
};

export const aaveCreateSupply = async (
  request: FastifyRequest<{ Body: SupplyBody }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
) => {
  const keyName: string = 'aave-supply';
  let logKey = `[op:${keyName}:${''}:${''}:${''}]`;

  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, amount, token } = request.body;
    const { networkConfig } = request.server as FastifyInstance;

    logKey = `[op:${keyName}:${channel_user_id || ''}:${token}:${amount}]`;

    // Validaciones mínimas siguiendo el estilo del ejemplo
    if (!channel_user_id || typeof channel_user_id !== 'string') {
      return await returnErrorResponse(reply, 400, 'channel_user_id is required (string)');
    }
    if (!amount || typeof amount !== 'string') {
      return await returnErrorResponse(reply, 400, 'amount is required (string)');
    }
    if (!token || token.toUpperCase() !== 'USDC') {
      return await returnErrorResponse(reply, 400, 'Only USDC is supported');
    }

    const fromUser: IUser | null = await getUser(channel_user_id);
    if (!fromUser) {
      Logger.info(keyName, logKey, COMMON_REPLY_WALLET_NOT_CREATED);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      fromUser?.wallets,
      networkConfig.chainId
    );

    let validationError: string;
    if (!userWallet) {
      validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
      Logger.info(keyName, logKey, validationError);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, validationError);
    }

    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, fromUser);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(
        userWallet.wallet_proxy,
        channel_user_id,
        ''
      );
      return undefined;
    }

    const result = await aaveService.supplyERC20(
      checkBlockchainConditionsResult.setupContractsResult!,
      amount,
      userWallet.wallet_eoa,
      logKey
    );

    if (!result.success) {
      Logger.info(keyName, logKey, `Supply failed: ${result.error}`);
      await sendInternalErrorNotification(userWallet.wallet_eoa, channel_user_id, 0, '');
      return undefined;
    }

    await sendAAVESuplyNotification(fromUser.phone_number, amount, token, result.txHash);
    Logger.info(keyName, logKey, `AAVE Supply completed successfully., ${result.txHash}`);
  } catch (error) {
    Logger.error(keyName, logKey, error);
  }
};

export const aaveGetSupplyInfo = async (request: FastifyRequest, reply: FastifyReply) => {
  const keyName: string = 'aave-supply-info';
  let logKey = `[op:${keyName}:${''}]`;

  try {
    const { channel_user_id } = request.query as { channel_user_id?: string };

    if (!channel_user_id) {
      Logger.warn('balanceByPhoneNumber', 'Phone number is required');
      return await returnErrorResponse(reply, 400, 'Phone number is required');
    }

    const { networkConfig } = request.server as FastifyInstance;

    logKey = `[op:${keyName}:${channel_user_id || ''}`;

    const fromUser: IUser | null = await getUser(channel_user_id);
    if (!fromUser) {
      Logger.info(keyName, logKey, COMMON_REPLY_WALLET_NOT_CREATED);
      return await returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
    }

    const userWallet: IUserWallet | null = getUserWalletByChainId(
      fromUser.wallets,
      networkConfig.chainId
    );

    if (!userWallet) {
      const validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
      Logger.info(keyName, logKey, validationError);
      return await returnSuccessResponse(reply, validationError);
    }

    const checkBlockchainConditionsResult: CheckBalanceConditionsResult =
      await checkBlockchainConditions(networkConfig, fromUser);

    if (!checkBlockchainConditionsResult.success) {
      await sendNoValidBlockchainConditionsNotification(
        userWallet.wallet_proxy,
        channel_user_id,
        ''
      );
      return undefined;
    }

    const result = await aaveService.getSupplyInfo(
      checkBlockchainConditionsResult.setupContractsResult!,
      userWallet.wallet_eoa,
      logKey
    );

    if (!result.success) {
      Logger.info(keyName, logKey, `Token info retrieval failed: ${result.error}`);
      return await returnErrorResponse(
        reply,
        500,
        `Failed to retrieve token information: ${result.error}`
      );
    }

    // Format response with only APY and aToken balance
    let responseMessage = `💰 Wallet Balance: ${result.tokenBalance?.balance} ${result.tokenBalance?.symbol}\n\n`;

    if (result.supplyInfo) {
      responseMessage += `📊 AAVE Supply:\n`;
      responseMessage += `• Supplied: ${result.supplyInfo.aTokenBalance} ${result.supplyInfo.aTokenSymbol}\n`;
      responseMessage += `• APY: ${result.supplyInfo.supplyAPY}%\n`;
    } else {
      responseMessage += `ℹ️ AAVE supply data not available\n`;
    }

    Logger.info(keyName, logKey, `Token information retrieved successfully`);
    return await returnSuccessResponse(reply, responseMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error(keyName, logKey, `Unexpected error: ${errorMessage}`);
    return await returnErrorResponse(reply, 500, 'Internal server error');
  }
};
