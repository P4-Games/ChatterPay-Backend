import { once as onceEvent } from 'events';
import { ServerResponse, IncomingMessage } from 'http';
import { FastifyReply, FastifyRequest, FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { AaveWithdrawResult } from '../types/aaveType';
import { IUser, IUserWallet } from '../models/userModel';
import { aaveService } from '../services/aave/aaveService';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { CheckBalanceConditionsResult } from '../types/commonType';
import { checkBlockchainConditions } from '../services/blockchainService';
import { getUser, getUserWalletByChainId } from '../services/userService';
import {
  COMMON_REPLY_WALLET_NOT_CREATED,
  COMMON_REPLY_OPERATION_IN_PROGRESS
} from '../config/constants';
import {
  sendInternalErrorNotification,
  sendAaveSupplyInfoNotification,
  sendAAVECreateSuplyNotification,
  sendAAVERemoveSuplyNotification,
  sendNoValidBlockchainConditionsNotification
} from '../services/notificationService';

type AaveSupplyBody = {
  channel_user_id: string;
  amount: string;
  token: string;
};

type AaveRemoveBody = {
  channel_user_id: string;
  token: string;
};

type AaaveInfoBody = {
  channel_user_id: string;
};

type AaveCommonQuery = {
  lastBotMsgDelaySeconds?: number;
};

export const aaveCreateSupply = async (
  request: FastifyRequest<{ Body: AaveSupplyBody; Querystring?: AaveCommonQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  // Immediate response to the user
  reply.send({
    status: 'success',
    data: {
      message: COMMON_REPLY_OPERATION_IN_PROGRESS
    },
    timestamp: new Date().toISOString()
  });

  const res = reply.raw as ServerResponse<IncomingMessage>;
  if (!res.writableFinished) {
    await Promise.race([
      onceEvent(res, 'finish'), // response successfully sent
      onceEvent(res, 'close') // client closed connection earlier; we still continue
    ]);
  }

  // Async processing after the reply
  // eslint-disable-next-line consistent-return
  (async () => {
    const keyName: string = 'aave-create-supply';
    let logKey = `[op:${keyName}:${''}:${''}:${''}]`;

    try {
      if (!request.body) throw new Error('Missing request body');

      const startTime = Date.now();
      const delaySecondsValue = request.query?.lastBotMsgDelaySeconds || 0;
      const { channel_user_id, amount, token } = request.body;
      const { networkConfig } = request.server as FastifyInstance;
      logKey = `[op:${keyName}:${channel_user_id || ''}:${token}:${amount}]`;

      if (!channel_user_id) throw new Error('Missing channel_user_id in body');
      if (!isValidPhoneNumber(channel_user_id)) {
        throw new Error(`Invalid phone number: '${channel_user_id}'`);
      }

      if (!amount || typeof amount !== 'string') {
        throw new Error(`Invalid amount: '${amount}'`);
      }

      if (!token || token.toUpperCase() !== 'USDC') {
        throw new Error(`Invalid token, Only USDC is supported`);
      }

      const fromUser: IUser | null = await getUser(channel_user_id);
      if (!fromUser) {
        Logger.info(keyName, logKey, COMMON_REPLY_WALLET_NOT_CREATED);
        throw new Error(COMMON_REPLY_WALLET_NOT_CREATED);
      }

      const userWallet: IUserWallet | null = getUserWalletByChainId(
        fromUser?.wallets,
        networkConfig.chainId
      );

      let validationError: string;
      if (!userWallet) {
        // TODO: Pasar a una notificación
        validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
        throw new Error(validationError);
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

      const processingTimeMs = Date.now() - startTime;
      const delayMs = delaySecondsValue * 1000;
      if (delayMs > 0) {
        const remainingDelay = delayMs - processingTimeMs;

        if (remainingDelay > 0) {
          Logger.log(keyName, logKey, `Waiting ${remainingDelay}ms for bot notification`);
          await delaySeconds(remainingDelay / 1000);
        } else {
          Logger.log(
            keyName,
            logKey,
            `Skipping bot notification delay due to overrun (${processingTimeMs}ms > ${delayMs}ms)`
          );
        }
      }

      if (!result.success) {
        Logger.info(keyName, logKey, `Supply failed: ${result.error}`);
        await sendInternalErrorNotification(channel_user_id, 0, '');
        return undefined;
      }

      await sendAAVECreateSuplyNotification(fromUser.phone_number, amount, token, result.txHash);
      Logger.info(keyName, logKey, `AAVE Supply completed successfully., ${result.txHash}`);
    } catch (error) {
      const err = error as Error;
      Logger.error(keyName, logKey, err.message || err);
    }
  })();
  return reply;
};

export const aaveUpdateSupply = async (
  request: FastifyRequest<{ Body: AaveSupplyBody; Querystring?: AaveCommonQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  // Immediate response to the user
  reply.send({
    status: 'success',
    data: {
      message: COMMON_REPLY_OPERATION_IN_PROGRESS
    },
    timestamp: new Date().toISOString()
  });

  const res = reply.raw as ServerResponse<IncomingMessage>;
  if (!res.writableFinished) {
    await Promise.race([
      onceEvent(res, 'finish'), // response successfully sent
      onceEvent(res, 'close') // client closed connection earlier; we still continue
    ]);
  }

  // Async processing after the reply
  // eslint-disable-next-line consistent-return
  (async () => {
    const keyName: string = 'aave-update-supply';
    let logKey = `[op:${keyName}:${''}:${''}:${''}]`;

    try {
      if (!request.body) throw new Error('Missing request body');

      const { channel_user_id, amount, token } = request.body;
      const { networkConfig } = request.server as FastifyInstance;
      const { lastBotMsgDelaySeconds = 0 } = request.query as AaveCommonQuery;
      const startTime = Date.now();
      logKey = `[op:${keyName}:${channel_user_id || ''}:${token}:${amount}]`;

      if (!channel_user_id) throw new Error('Missing channel_user_id in body');
      if (!isValidPhoneNumber(channel_user_id)) {
        throw new Error(`Invalid phone number: '${channel_user_id}'`);
      }

      if (!amount || typeof amount !== 'string') {
        throw new Error(`Invalid amount: '${amount}'`);
      }

      if (!token || token.toUpperCase() !== 'USDC') {
        throw new Error(`Invalid token, Only USDC is supported`);
      }

      const fromUser: IUser | null = await getUser(channel_user_id);
      if (!fromUser) {
        Logger.info(keyName, logKey, COMMON_REPLY_WALLET_NOT_CREATED);
        throw new Error(COMMON_REPLY_WALLET_NOT_CREATED);
      }

      const userWallet: IUserWallet | null = getUserWalletByChainId(
        fromUser?.wallets,
        networkConfig.chainId
      );

      let validationError: string;
      if (!userWallet) {
        // TODO: Pasar a una notificación
        validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
        throw new Error(validationError);
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

      const result: AaveWithdrawResult = await aaveService.withdrawAmount(
        checkBlockchainConditionsResult.setupContractsResult!,
        amount,
        logKey
      );

      const processingTimeMs = Date.now() - startTime;
      const delayMs = lastBotMsgDelaySeconds * 1000;
      if (delayMs > 0) {
        const remainingDelay = delayMs - processingTimeMs;

        if (remainingDelay > 0) {
          Logger.log(keyName, logKey, `Waiting ${remainingDelay}ms for bot notification`);
          await delaySeconds(remainingDelay / 1000);
        } else {
          Logger.log(
            keyName,
            logKey,
            `Skipping bot notification delay due to overrun (${processingTimeMs}ms > ${delayMs}ms)`
          );
        }
      }

      if (!result.success) {
        Logger.info(keyName, logKey, `Update failed: ${result.error}`);
        await sendInternalErrorNotification(channel_user_id, 0, '');
        return undefined;
      }

      await sendAAVERemoveSuplyNotification(fromUser.phone_number, amount, token, result.txHash!);
      Logger.info(keyName, logKey, `AAVE Supply completed successfully., ${result.txHash}`);
    } catch (error) {
      const err = error as Error;
      Logger.error(keyName, logKey, err.message || err);
    }
  })();
  return reply;
};

export const aaveRemoveSupply = async (
  request: FastifyRequest<{ Body: AaveRemoveBody; Querystring?: AaveCommonQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  // Immediate response to the user
  reply.send({
    status: 'success',
    data: {
      message: COMMON_REPLY_OPERATION_IN_PROGRESS
    },
    timestamp: new Date().toISOString()
  });

  const res = reply.raw as ServerResponse<IncomingMessage>;
  if (!res.writableFinished) {
    await Promise.race([
      onceEvent(res, 'finish'), // response successfully sent
      onceEvent(res, 'close') // client closed connection earlier; we still continue
    ]);
  }

  // Async processing after the reply
  // eslint-disable-next-line consistent-return
  (async () => {
    const keyName: string = 'aave-remove-supply';
    let logKey = `[op:${keyName}:${''}:${''}:${''}]`;

    try {
      if (!request.body) throw new Error('Missing request body');

      const { channel_user_id, token } = request.body;
      const { networkConfig } = request.server as FastifyInstance;
      const { lastBotMsgDelaySeconds = 0 } = request.query as AaveCommonQuery;
      const startTime = Date.now();
      logKey = `[op:${keyName}:${channel_user_id || ''}:${token}:amount: all]`;

      if (!channel_user_id) throw new Error('Missing channel_user_id in body');
      if (!isValidPhoneNumber(channel_user_id)) {
        throw new Error(`Invalid phone number: '${channel_user_id}'`);
      }

      if (!token || token.toUpperCase() !== 'USDC') {
        throw new Error(`Invalid token, Only USDC is supported`);
      }

      const fromUser: IUser | null = await getUser(channel_user_id);
      if (!fromUser) {
        Logger.info(keyName, logKey, COMMON_REPLY_WALLET_NOT_CREATED);
        throw new Error(COMMON_REPLY_WALLET_NOT_CREATED);
      }

      const userWallet: IUserWallet | null = getUserWalletByChainId(
        fromUser?.wallets,
        networkConfig.chainId
      );

      let validationError: string;
      if (!userWallet) {
        // TODO: Pasar a una notificación
        validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
        throw new Error(validationError);
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

      const result: AaveWithdrawResult = await aaveService.withdrawMax(
        checkBlockchainConditionsResult.setupContractsResult!,
        logKey
      );

      const processingTimeMs = Date.now() - startTime;
      const delayMs = lastBotMsgDelaySeconds * 1000;
      if (delayMs > 0) {
        const remainingDelay = delayMs - processingTimeMs;

        if (remainingDelay > 0) {
          Logger.log(keyName, logKey, `Waiting ${remainingDelay}ms for bot notification`);
          await delaySeconds(remainingDelay / 1000);
        } else {
          Logger.log(
            keyName,
            logKey,
            `Skipping bot notification delay due to overrun (${processingTimeMs}ms > ${delayMs}ms)`
          );
        }
      }

      if (!result.success) {
        Logger.info(keyName, logKey, `Supply failed: ${result.error}`);
        await sendInternalErrorNotification(channel_user_id, 0, '');
        return undefined;
      }

      await sendAAVERemoveSuplyNotification(
        fromUser.phone_number,
        result.amountWithdrawn!,
        token,
        result.txHash!
      );
      Logger.info(keyName, logKey, `AAVE Supply completed successfully., ${result.txHash}`);
    } catch (error) {
      const err = error as Error;
      Logger.error(keyName, logKey, err.message || err);
    }
  })();
  return reply;
};

export const aaveGetSupplyInfo = async (
  request: FastifyRequest<{ Body: AaaveInfoBody; Querystring?: AaveCommonQuery }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  // Immediate response to the user
  reply.send({
    status: 'success',
    data: {
      message: COMMON_REPLY_OPERATION_IN_PROGRESS
    },
    timestamp: new Date().toISOString()
  });

  const res = reply.raw as ServerResponse<IncomingMessage>;
  if (!res.writableFinished) {
    await Promise.race([
      onceEvent(res, 'finish'), // response successfully sent
      onceEvent(res, 'close') // client closed connection earlier; we still continue
    ]);
  }

  // Async processing after the reply
  // eslint-disable-next-line consistent-return
  (async () => {
    const keyName: string = 'aave-supply-info';
    let logKey = `[op:${keyName}:${''}]`;

    try {
      if (!request.body) throw new Error('Missing request body');

      const { channel_user_id } = request.body;
      const { lastBotMsgDelaySeconds = 0 } = request.query as AaveCommonQuery;
      if (!channel_user_id) throw new Error('Missing channel_user_id in body');
      if (!isValidPhoneNumber(channel_user_id)) {
        throw new Error(`Invalid phone number: '${channel_user_id}'`);
      }
      const startTime = Date.now();
      const { networkConfig } = request.server as FastifyInstance;

      logKey = `[op:${keyName}:${channel_user_id || ''}`;

      const fromUser: IUser | null = await getUser(channel_user_id);
      if (!fromUser) {
        Logger.info(keyName, logKey, COMMON_REPLY_WALLET_NOT_CREATED);
        throw new Error(COMMON_REPLY_WALLET_NOT_CREATED);
      }
      const userWallet: IUserWallet | null = getUserWalletByChainId(
        fromUser?.wallets,
        networkConfig.chainId
      );

      let validationError: string;
      if (!userWallet) {
        // TODO: Pasar a una notificación
        validationError = `Wallet not found for user ${channel_user_id} and chain ${networkConfig.chainId}`;
        throw new Error(validationError);
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

      const processingTimeMs = Date.now() - startTime;
      const delayMs = lastBotMsgDelaySeconds * 1000;
      if (delayMs > 0) {
        const remainingDelay = delayMs - processingTimeMs;

        if (remainingDelay > 0) {
          Logger.log(keyName, logKey, `Waiting ${remainingDelay}ms for bot notification`);
          await delaySeconds(remainingDelay / 1000);
        } else {
          Logger.log(
            keyName,
            logKey,
            `Skipping bot notification delay due to overrun (${processingTimeMs}ms > ${delayMs}ms)`
          );
        }
      }

      if (!result.success) {
        Logger.info(keyName, logKey, `Token info retrieval failed: ${result.error}`);
        await sendInternalErrorNotification(channel_user_id, 0, '');
        return undefined;
      }

      await sendAaveSupplyInfoNotification(fromUser.phone_number, result.supplyInfo!);
      Logger.info(keyName, logKey, `Token information retrieved successfully`);
    } catch (error) {
      const err = error as Error;
      Logger.error(keyName, logKey, err.message || err);
    }
  })();
  return reply;
};
