import axios from 'axios';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import { channels as PushAPIChannels, payloads as PushAPIPayloads } from '@pushprotocol/restapi';

import { getUser } from './mongo/mongoService';
import { Logger } from '../helpers/loggerHelper';
import { getNetworkConfig } from './networkService';
import { IBlockchain } from '../models/blockchainModel';
import { IUser, IUserWallet } from '../models/userModel';
import { getTemplate, templateEnum } from './templateService';
import { isValidPhoneNumber } from '../helpers/validationHelper';
import {
  LanguageEnum,
  ITemplateSchema,
  NotificationEnum,
  NotificationTemplatesTypes
} from '../models/templateModel';
import {
  BOT_API_URL,
  PUSH_ENABLED,
  PUSH_NETWORK,
  BOT_DATA_TOKEN,
  PUSH_ENVIRONMENT,
  DEFAULT_CHAIN_ID,
  CHATTERPAY_DOMAIN,
  PUSH_CHANNEL_ADDRESS,
  GCP_CLOUD_TRACE_ENABLED,
  PUSH_CHANNEL_PRIVATE_KEY,
  BOT_NOTIFICATIONS_ENABLED,
  CHATTERPAY_NFTS_SHARE_URL,
  NOTIFICATION_TEMPLATE_CACHE_TTL,
  SETTINGS_NOTIFICATION_LANGUAGE_DFAULT
} from '../config/constants';

interface OperatorReplyPayload {
  data_token: string;
  channel_user_id: string;
  message: string;
}

const notificationTemplateCache = new NodeCache({ stdTTL: NOTIFICATION_TEMPLATE_CACHE_TTL });

/**
 * Retrieves the wallet for a specific chain_id from a user's wallet array.
 * This function is internal to avoid circular imports between userService and notificationService.
 * @param {IUserWallet[]} wallets - The array of wallets to search through.
 * @param {number} chainId - The chain_id to filter the wallet.
 * @returns {IUserWallet | null} The wallet corresponding to the provided chain_id, or null if no matching wallet is found.
 */
export const getUserWalletByChainIdInternal = (
  wallets: IUserWallet[],
  chainId: number
): IUserWallet | null => {
  const wallet = wallets.find((w) => w.chain_id === chainId);
  return wallet || null;
};

/**
 * Sends an operator reply to the API.
 *
 * @param payload
 * @returns
 */
async function sendBotNotification(
  payload: OperatorReplyPayload,
  traceHeader?: string
): Promise<string> {
  try {
    if (!BOT_NOTIFICATIONS_ENABLED) {
      Logger.info(
        'sendBotNotification',
        `Bot notifications are disabled. Omitted payload: ${JSON.stringify(payload)}`
      );
      return '';
    }

    const headers: { [key: string]: string } = {
      'Content-Type': 'application/json'
    };

    if (GCP_CLOUD_TRACE_ENABLED && traceHeader) {
      headers['X-Cloud-Trace-Context'] = traceHeader;
    }

    const sendMsgEndpint = `${BOT_API_URL}/chatbot/conversations/send-message`;
    const response = await axios.post(sendMsgEndpint, payload, {
      headers
    });
    Logger.log(
      'sendBotNotification',
      'API Response:',
      payload.channel_user_id,
      payload.message,
      response.data
    );
    return response.data;
  } catch (error) {
    Logger.error('sendBotNotification', (error as Error).message);
    throw error;
  }
}

/**
 * Send Push Notificaiton
 *
 * @param title Notification Title
 * @param msg Notification Message
 * @param type 1 -> Broadcast, 3 -> Targeted
 * @param identityType // 0 -> Minimal, 2 -> Direct Payload
 */
export async function sendPushNotificaton(
  title: string,
  msg: string,
  channelUserId: string,
  type: number = 3,
  identityType: number = 2
): Promise<boolean> {
  try {
    if (!PUSH_ENABLED) {
      Logger.info('sendPushNotificaton', `Push notifications are disabled.`);
      return true;
    }

    const user: IUser | null = await getUser(channelUserId);
    if (!user) {
      Logger.log(
        'sendPushNotificaton',
        `Push notification not sent: Invalid user in the database for phone number ${channelUserId}`
      );
      return false;
    }

    const userWallet: IUserWallet | null = getUserWalletByChainIdInternal(
      user.wallets,
      DEFAULT_CHAIN_ID
    );
    if (!userWallet) {
      Logger.log(
        'sendPushNotificaton',
        `Push notification not sent: Invalid EOA Wallet in the database for phone number ${channelUserId}`
      );
      return false;
    }

    let { wallet_eoa } = userWallet;
    wallet_eoa = wallet_eoa.startsWith('0x') ? wallet_eoa : `0x${wallet_eoa}`;

    const signer = new ethers.Wallet(PUSH_CHANNEL_PRIVATE_KEY);
    const apiResponse = await PushAPIPayloads.sendNotification({
      signer,
      type,
      identityType,
      notification: {
        title,
        body: msg
      },
      payload: {
        title,
        body: msg,
        cta: CHATTERPAY_DOMAIN,
        img: `${CHATTERPAY_DOMAIN}/assets/images/home/logo.png`
      },
      recipients: `eip155:${PUSH_NETWORK}:${wallet_eoa}`,
      channel: `eip155:${PUSH_NETWORK}:${PUSH_CHANNEL_ADDRESS}`,
      env: PUSH_ENVIRONMENT
    });

    Logger.log(
      'sendPushNotificaton',
      `Push notification sent successfully to ${channelUserId},  ${wallet_eoa}:`,
      apiResponse.status,
      apiResponse.statusText
    );
    return true;
  } catch (error) {
    Logger.error(
      'sendPushNotificaton',
      `Error sending Push Notification to ${channelUserId}:`,
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
}

/**
 * Gets user language based on the phone number.
 *
 * @param phoneNumber
 * @returns
 */
export const getUserSettingsLanguage = async (phoneNumber: string): Promise<LanguageEnum> => {
  let language: LanguageEnum = SETTINGS_NOTIFICATION_LANGUAGE_DFAULT as LanguageEnum;
  try {
    const user: IUser | null = await getUser(phoneNumber);
    if (user && user.settings) {
      const userLanguage = user.settings.notifications.language;
      if (Object.values(LanguageEnum).includes(userLanguage as LanguageEnum)) {
        language = userLanguage as LanguageEnum;
      } else {
        Logger.warn(
          'getUserSettingsLanguage',
          `Invalid language detected for user ${phoneNumber}, defaulting to ${SETTINGS_NOTIFICATION_LANGUAGE_DFAULT}`
        );
      }
    }
  } catch (error: unknown) {
    // avoid throw error
    Logger.error(
      'getUserSettingsLanguage',
      `Error getting user settings language for ${phoneNumber}, error: ${(error as Error).message}`
    );
  }
  return language;
};

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

    const userLanguage: LanguageEnum = await getUserSettingsLanguage(channelUserId);

    const notificationTemplates: NotificationTemplatesTypes | null =
      await getTemplate<ITemplateSchema>(templateEnum.NOTIFICATIONS);
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
 * Subscribe User To Push Channel
 *
 * @param user_private_key
 * @param user_address
 * @returns
 */
export async function subscribeToPushChannel(
  user_private_key: string,
  user_address: string
): Promise<boolean> {
  try {
    let userPrivateKeyFormatted = user_private_key;
    let userAddressFormatted = user_address;

    if (!user_private_key.startsWith('0x')) {
      userPrivateKeyFormatted = `0x${user_private_key}`;
    }
    if (!user_address.startsWith('0x')) {
      userAddressFormatted = `0x${user_address}`;
    }

    const signer = new ethers.Wallet(userPrivateKeyFormatted);
    const subscriptionResponse = await PushAPIChannels.subscribe({
      signer,
      channelAddress: `eip155:${PUSH_NETWORK}:${PUSH_CHANNEL_ADDRESS}`,
      userAddress: `eip155:${PUSH_NETWORK}:${userAddressFormatted}`,
      onSuccess: () => {
        Logger.log(
          'subscribeToPushChannel',
          `${userAddressFormatted} successfully subscribed to Push Protocol Channel`
        );
      },
      onError: (error: unknown) => {
        Logger.error(
          'subscribeToPushChannel',
          `Error trying to subscribe ${userAddressFormatted} to Push Protocol channel:`,
          error
        );
      },
      env: PUSH_ENVIRONMENT
    });

    Logger.log(
      'subscribeToPushChannel',
      `${userAddressFormatted} Push Protocol Subscription Response:`,
      JSON.stringify(subscriptionResponse)
    );
    return true;
  } catch (error) {
    // Avoid throwing an error if subscribing to the push channel fails
    Logger.error(
      'subscribeToPushChannel',
      `Error trying to subscribe ${user_address} to Push Channel:`,
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
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

    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
  } catch (error) {
    Logger.error('sendWalletCreationNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for a transfer.
 *
 * @param channel_user_id
 * @param from
 * @param amount
 * @param token
 * @returns
 */
export async function sendTransferNotification(
  channel_user_id: string,
  from: string | null,
  amount: string,
  token: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log(
      'sendTransferNotification',
      `Sending transfer notification from ${from} to ${channel_user_id}`
    );
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.transfer
    );
    const formattedMessage = message
      .replaceAll('[FROM]', from || '0X')
      .replaceAll('[AMOUNT]', amount)
      .replaceAll('[TOKEN]', token);

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendTransferNotification', error);
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
    const networkConfig: IBlockchain = await getNetworkConfig();

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

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
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

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('sendMintNotification', (error as Error).message);
    throw error;
  }
}

/**
 * Sends a notification for an outgoing transfer.
 *
 * @param address_of_user
 * @param channel_user_id
 * @param walletTo
 * @param amount
 * @param token
 * @param txHash
 * @returns
 */
export async function sendOutgoingTransferNotification(
  channel_user_id: string,
  walletTo: string | null,
  amount: string,
  token: string,
  txHash: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log('sendOutgoingTransferNotification', 'Sending outgoing transfer notification');
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const networkConfig: IBlockchain = await getNetworkConfig();

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.outgoing_transfer
    );
    const formattedMessage = message
      .replaceAll('[AMOUNT]', amount)
      .replaceAll('[TOKEN]', token)
      .replaceAll('[TO]', channel_user_id || walletTo || '0x')
      .replaceAll('[EXPLORER]', networkConfig.explorer)
      .replaceAll('[TX_HASH]', txHash);

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
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

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, message, channel_user_id); // avoid await
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

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, message, channel_user_id); // avoid await
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

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, message, channel_user_id); // avoid await
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

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await sendBotNotification(payload, traceHeader);
    sendPushNotificaton(title, message, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('SendConcurrecyOperationNotification', error);
    throw error;
  }
}
