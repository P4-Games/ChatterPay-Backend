import { once as onceEvent } from 'events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'http';
import { IS_DEVELOPMENT, ISSUER_TOKENS_ENABLED } from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { NotificationEnum } from '../models/templateModel';
import {
  getNotificationTemplate,
  sendWalletAlreadyExistsNotification,
  sendWalletCreationNotification
} from '../services/notificationService';
import { createOrReturnWallet, tryIssueTokens } from '../services/walletService';

/**
 * Retrieves the ChatterPay wallet address associated with the given user.
 * If the wallet does not exist, it will be created automatically.
 *
 * This endpoint is typically used by the on-ramp flow to obtain the user's wallet
 * address before redirecting them to an external provider (e.g., Onramp.Money).
 *
 * @param {FastifyRequest<{
 *   Body: { channel_user_id: string };
 *   Querystring?: { lastBotMsgDelaySeconds?: number };
 * }>} request - Fastify request containing the user's WhatsApp ID or phone number.
 *
 * @param {FastifyReply} reply - Fastify reply object used to send the HTTP response.
 *
 * @returns {Promise<FastifyReply>} A promise that resolves with the user's wallet
 * address in the HTTP response, or an error if the process fails.
 */
export const getRampWallet = async (
  request: FastifyRequest<{
    Body: { channel_user_id: string; referral_by_code?: string };
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    if (!request.body) throw new Error('Missing request body');

    const { channel_user_id, referral_by_code } = request.body;
    if (!channel_user_id) throw new Error('Missing channel_user_id in body');

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnSuccessResponse(reply, `Invalid phone number: '${channel_user_id}'`);
    }

    const logKey = `[op:getRampWallet:${channel_user_id}]`;
    const { networkConfig } = request.server;

    const { message, walletAddress } = await createOrReturnWallet(
      channel_user_id,
      networkConfig,
      logKey,
      referral_by_code
    );

    Logger.log('getRampWallet', logKey, `${message}, ${walletAddress}`);

    return await returnSuccessResponse(reply, walletAddress);
  } catch (error) {
    const err = error as Error;
    return returnErrorResponse(
      'getRampWallet',
      err.message ?? '',
      reply,
      500,
      'Internal Server Error'
    );
  }
};

/**
 * Handles the creation of a new wallet for the user.
 * @param {FastifyRequest<{ Body: { channel_user_id: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the result.
 */
export const createWallet = async (
  request: FastifyRequest<{
    Body: { channel_user_id: string; referral_by_code?: string };
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  // Immediate response to the user
  reply.send({
    status: 'success',
    data: {
      message: 'We are processing your request. You will be notified shortly.'
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
  (async () => {
    let logKey = '[op:createWallet:unknown]';
    const delaySecondsValue = request.query?.lastBotMsgDelaySeconds || 0;
    const startTime = Date.now();

    try {
      if (!request.body) throw new Error('Missing request body');

      const { channel_user_id, referral_by_code } = request.body;
      logKey = `[op:createWallet:${channel_user_id}]`;

      if (!channel_user_id) throw new Error('Missing channel_user_id in body');
      if (!isValidPhoneNumber(channel_user_id)) {
        throw new Error(`Invalid phone number: '${channel_user_id}'`);
      }

      const { networkConfig, tokens } = request.server;

      const { message, walletAddress, wasWalletCreated } = await createOrReturnWallet(
        channel_user_id,
        networkConfig,
        logKey,
        referral_by_code
      );

      const processingTimeMs = Date.now() - startTime;
      const delayMs = delaySecondsValue * 1000;
      if (delayMs > 0) {
        const remainingDelay = delayMs - processingTimeMs;

        if (remainingDelay > 0) {
          Logger.log('createWallet2', logKey, `Waiting ${remainingDelay}ms for bot notification`);
          await delaySeconds(remainingDelay / 1000);
        } else {
          Logger.log(
            'createWallet2',
            logKey,
            `Skipping bot notification delay due to overrun (${processingTimeMs}ms > ${delayMs}ms)`
          );
        }
      }
      if (wasWalletCreated) {
        await sendWalletCreationNotification(walletAddress, channel_user_id, networkConfig.name);
      } else {
        await sendWalletAlreadyExistsNotification(
          walletAddress,
          channel_user_id,
          networkConfig.name
        );
      }

      if (
        wasWalletCreated &&
        networkConfig.environment.toUpperCase() !== 'PRODUCTION' &&
        IS_DEVELOPMENT &&
        ISSUER_TOKENS_ENABLED
      ) {
        Logger.log('createWallet', logKey, `Issuing tokens for ${walletAddress}`);
        await tryIssueTokens(walletAddress, tokens, networkConfig);
      }

      Logger.log('createWallet', logKey, `${message}, ${walletAddress}`);
    } catch (error) {
      const err = error as Error;
      Logger.error('createWallet', logKey, err.message || err);
    }
  })();

  return reply;
};

/**
 * Handles the creation of a new wallet for the user.
 * @param {FastifyRequest<{ Body: { channel_user_id: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object used to send the response.
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the result.
 */
export const createWalletSync = async (
  request: FastifyRequest<{
    Body: { channel_user_id: string; referral_by_code?: string };
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  let logKey = '[op:createWalletSync:unknown]';

  try {
    if (!request.body) throw new Error('Missing request body');

    const { channel_user_id, referral_by_code } = request.body;
    logKey = `[op:createWalletSync:${channel_user_id}]`;

    if (!channel_user_id) throw new Error('Missing channel_user_id in body');
    if (!isValidPhoneNumber(channel_user_id)) {
      throw new Error(`Invalid phone number: '${channel_user_id}'`);
    }

    const { networkConfig, tokens } = request.server;

    const {
      message: walletResultMessage,
      walletAddress,
      wasWalletCreated
    } = await createOrReturnWallet(channel_user_id, networkConfig, logKey, referral_by_code);

    const notificationType = wasWalletCreated
      ? NotificationEnum.wallet_creation
      : NotificationEnum.wallet_already_exists;

    const { message: templateMessage } = await getNotificationTemplate(
      channel_user_id,
      notificationType
    );

    const notificationMessage = templateMessage
      .replace('[WALLET_ADDRESS]', walletAddress)
      .replace('[NETWORK_NAME]', networkConfig.name);

    if (
      wasWalletCreated &&
      networkConfig.environment.toUpperCase() !== 'PRODUCTION' &&
      IS_DEVELOPMENT &&
      ISSUER_TOKENS_ENABLED
    ) {
      Logger.log('createWalletSync', logKey, `Issuing tokens for ${walletAddress}`);
      await tryIssueTokens(walletAddress, tokens, networkConfig);
    }

    Logger.log('createWalletSync', logKey, `${walletResultMessage}, ${walletAddress}`);

    return await reply.send({
      status: 'success',
      data: {
        message: notificationMessage,
        walletAddress,
        wasWalletCreated
      }
    });
  } catch (error) {
    const err = error as Error;
    Logger.error('createWalletSync', logKey, err.message || err);

    return reply.status(500).send({
      status: 'error',
      message: err.message || 'Internal error'
    });
  }
};
