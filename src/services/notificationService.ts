import NodeCache from 'node-cache';

import { Logger } from '../helpers/loggerHelper';
import { pushService } from './push/pushService';
import { IBlockchain } from '../models/blockchainModel';
import { mongoUserService } from './mongo/mongoUserService';
import { chatizaloService } from './chatizalo/chatizaloService';
import { chatizaloOperatorReply } from '../types/chatizaloType';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { formatPhoneNumberWithOptionalName } from '../helpers/formatHelper';
import { templateEnum, mongoTemplateService } from './mongo/mongoTemplateService';
import {
  BOT_DATA_TOKEN,
  CHATTERPAY_NFTS_SHARE_URL,
  NOTIFICATION_TEMPLATE_CACHE_TTL
} from '../config/constants';
import {
  LanguageEnum,
  ITemplateSchema,
  NotificationEnum,
  NotificationTemplatesTypes
} from '../models/templateModel';

const notificationTemplateCache = new NodeCache({ stdTTL: NOTIFICATION_TEMPLATE_CACHE_TTL });

/**
 * Get Notification Template based on channel User Id and Notification Type
 *
 * @param channelUserId
 * @param typeOfNotification
 * @returns
 */
async function getNotificationTemplate(
  channelUserId: string,
  typeOfNotification: NotificationEnum
): Promise<{ title: string; message: string }> {
  const defaultNotification = { title: 'Chatterpay Message', message: '' };
  try {
    const cachedTemplate = notificationTemplateCache.get(`${typeOfNotification}`);
    if (cachedTemplate) {
      Logger.log('getNotificationTemplate', `getting ${typeOfNotification} from cache`);
      return cachedTemplate as { title: string; message: string };
    }

    const userLanguage: LanguageEnum =
      await mongoUserService.getUserSettingsLanguage(channelUserId);

    const notificationTemplates: NotificationTemplatesTypes | null =
      await mongoTemplateService.getTemplate<ITemplateSchema>(templateEnum.NOTIFICATIONS);
    if (!notificationTemplates) {
      Logger.warn('getNotificationTemplate', 'Notifications Templates not found');
      return defaultNotification;
    }

    if (!Object.values(NotificationEnum).includes(typeOfNotification)) {
      Logger.warn('getNotificationTemplate', `Invalid notification type: ${typeOfNotification}`);
      return defaultNotification;
    }

    // @ts-expect-error 'expected type error'
    const template = notificationTemplates[typeOfNotification];

    if (!template) {
      Logger.warn('getNotificationTemplate', `Notification type ${typeOfNotification} not found`);
      return defaultNotification;
    }

    const result = {
      title: template.title[userLanguage],
      message: template.message[userLanguage]
    };
    notificationTemplateCache.set(`${typeOfNotification}`, result);

    return result;
  } catch (error: unknown) {
    // avoid throw error
    Logger.error(
      'getNotificationTemplate',
      `Error getting notification template ${typeOfNotification}, error: ${(error as Error).message}`
    );
  }
  return defaultNotification;
}

/**
 * Sends wallet creation notification.
 *
 * @param address_of_user
 * @param channel_user_id
 */
export async function sendWalletCreationNotification(
  address_of_user: string,
  channel_user_id: string
) {
  try {
    Logger.log(
      'sendWalletCreationNotification',
      `Sending wallet creation notification to ${address_of_user}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.wallet_creation
    );
    const formattedMessage = message.replace('[PREDICTED_WALLET_EOA_ADDRESS]', address_of_user);

    pushService.sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
  } catch (error) {
    Logger.error('sendWalletCreationNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for a received transfer
 *
 * @param phoneNumberFrom
 * @param nameFrom
 * @param phoneNumberTo
 * @param amount
 * @param token
 * @returns
 */
export async function sendReceivedTransferNotification(
  phoneNumberFrom: string,
  nameFrom: string,
  phoneNumberTo: string,
  amount: string,
  token: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log(
      'sendReceivedTransferNotification',
      `Sending received transfer notification from ${phoneNumberFrom} to ${phoneNumberTo}`
    );
    if (!isValidPhoneNumber(phoneNumberTo)) return '';

    const { title, message } = await getNotificationTemplate(
      phoneNumberTo,
      NotificationEnum.transfer
    );

    const formatMessage = (fromNumberAndName: string) =>
      message
        .replaceAll('[FROM]', fromNumberAndName)
        .replaceAll('[AMOUNT]', amount)
        .replaceAll('[TOKEN]', token);

    const fromNumberAndName = formatPhoneNumberWithOptionalName(phoneNumberFrom, nameFrom, false);
    const fromNumberAndNameMasked = formatPhoneNumberWithOptionalName(
      phoneNumberFrom,
      nameFrom,
      true
    );

    const formattedMessageBot = formatMessage(fromNumberAndName);
    const formattedMessagePush = formatMessage(fromNumberAndNameMasked);

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id: phoneNumberTo,
      message: formattedMessageBot
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);

    // Send push notification with masked phone number
    pushService.sendPushNotificaton(title, formattedMessagePush, phoneNumberTo); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendReceivedTransferNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for a swap.
 *
 * @param channel_user_id
 * @param token
 * @param amount
 * @param result
 * @param outputToken
 * @param transactionHash
 * @returns
 */
export async function sendSwapNotification(
  channel_user_id: string,
  token: string,
  amount: string,
  result: string,
  outputToken: string,
  transactionHash: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log('sendSwapNotification', 'Sending swap notification');
    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();

    const resultString: string = `${Math.round(parseFloat(result) * 1e4) / 1e4}`;
    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.swap
    );

    const formattedMessage = message
      .replaceAll('[AMOUNT]', amount)
      .replaceAll('[TOKEN]', token)
      .replaceAll('[RESULT]', resultString)
      .replaceAll('[OUTPUT_TOKEN]', outputToken)
      .replaceAll('[EXPLORER]', networkConfig.explorer)
      .replaceAll('[TRANSACTION_HASH]', transactionHash);

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);
    pushService.sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendSwapNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for minted certificates and on-chain memories.
 *
 * @param address_of_user
 * @param channel_user_id
 * @param id
 * @returns
 */
export async function sendMintNotification(
  address_of_user: string,
  channel_user_id: string,
  id: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log('sendMintNotification', 'Sending mint notification');

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.mint
    );
    const formattedMessage = message
      .replaceAll('[ID]', id)
      .replaceAll('[NFTS_SHARE_URL]', CHATTERPAY_NFTS_SHARE_URL);

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);
    pushService.sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendMintNotification', (error as Error).message);
    throw error;
  }
}

/**
 * Sends a notification for an outgoing transfer.
 *
 * @param phoneNumberFrom
 * @param phoneNumberTo
 * @param toName
 * @param amount
 * @param token
 * @param txHash
 * @param traceHeader
 * @returns
 */
export async function sendOutgoingTransferNotification(
  phoneNumberFrom: string,
  phoneNumberTo: string,
  toName: string,
  amount: string,
  token: string,
  txHash: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log('sendOutgoingTransferNotification', 'Sending outgoing transfer notification');
    if (!isValidPhoneNumber(phoneNumberFrom)) return '';

    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();

    const { title, message } = await getNotificationTemplate(
      phoneNumberFrom,
      NotificationEnum.outgoing_transfer
    );

    const formatMessage = (toNumberAndName: string) =>
      message
        .replaceAll('[AMOUNT]', amount)
        .replaceAll('[TOKEN]', token)
        .replaceAll('[TO]', toNumberAndName)
        .replaceAll('[EXPLORER]', networkConfig.explorer)
        .replaceAll('[TX_HASH]', txHash);

    const toNumberAndName = formatPhoneNumberWithOptionalName(phoneNumberTo, toName, false);
    const toNumberAndNameMasked = formatPhoneNumberWithOptionalName(phoneNumberTo, toName, true);

    const formattedMessageBot = formatMessage(toNumberAndName);
    const formattedMessagePush = formatMessage(toNumberAndNameMasked);

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id: phoneNumberFrom,
      message: formattedMessageBot
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);

    // Send push notification with masked phone number
    pushService.sendPushNotificaton(title, formattedMessagePush, phoneNumberFrom); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendOutgoingTransferNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when user balance not enough
 *
 * @param address_of_user
 * @param channel_user_id
 */
export async function sendUserInsufficientBalanceNotification(
  address_of_user: string,
  channel_user_id: string,
  traceHeader?: string
) {
  try {
    Logger.log(
      'sendUserInsufficientBalanceNotification',
      `Sending User Insufficient Balance notification to ${address_of_user}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.user_balance_not_enough
    );

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);
    pushService.sendPushNotificaton(title, message, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendUserInsufficientBalanceNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when blockchain condition are invalid
 *
 * @param address_of_user
 * @param channel_user_id
 */
export async function sendNoValidBlockchainConditionsNotification(
  address_of_user: string,
  channel_user_id: string,
  traceHeader?: string
) {
  try {
    Logger.log(
      'sendNoValidBlockchainConditionsNotification',
      `Sending blockchain conditions invalid notification to ${address_of_user}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.no_valid_blockchain_conditions
    );

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);
    pushService.sendPushNotificaton(title, message, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendNoValidBlockchainConditionsNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when internal error
 *
 * @param address_of_user
 * @param channel_user_id
 */
export async function sendInternalErrorNotification(
  address_of_user: string,
  channel_user_id: string,
  traceHeader?: string
) {
  try {
    Logger.log(
      'sendInternalErrorNotification',
      `Sending internal error notification to ${address_of_user}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.internal_error
    );

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);
    pushService.sendPushNotificaton(title, message, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendInternalErrorNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when the user has concurrent operations.
 *
 * @param address_of_user
 * @param channel_user_id
 */
export async function SendConcurrecyOperationNotification(
  channel_user_id: string,
  traceHeader?: string
) {
  try {
    Logger.log(
      'SendConcurrecyOperationNotification',
      `Sending concurrent operation notification to ${channel_user_id}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.concurrent_operation
    );

    const payload: chatizaloOperatorReply = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await chatizaloService.sendBotNotification(payload, traceHeader);
    pushService.sendPushNotificaton(title, message, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('SendConcurrecyOperationNotification', error);
    throw error;
  }
}
