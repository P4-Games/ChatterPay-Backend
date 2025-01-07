import axios from 'axios';
import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import { channels as PushAPIChannels, payloads as PushAPIPayloads } from '@pushprotocol/restapi';

import { Logger } from '../utils/logger';
import { User, IUser } from '../models/user';
import { IBlockchain } from '../models/blockchain';
import { getNetworkConfig } from './networkService';
import { isValidPhoneNumber } from '../utils/validations';
import { getTemplate, templateEnum } from './templateService';
import {
  LanguageEnum,
  ITemplateSchema,
  NotificationEnum,
  NotificationTemplatesTypes
} from '../models/templates';
import {
  BOT_API_URL,
  PUSH_ENABLED,
  PUSH_NETWORK,
  BOT_DATA_TOKEN,
  PUSH_ENVIRONMENT,
  CHATTERPAY_DOMAIN,
  PUSH_CHANNEL_ADDRESS,
  PUSH_CHANNEL_PRIVATE_KEY,
  BOT_NOTIFICATIONS_ENABLED,
  CHATTERPAY_NFTS_SHARE_URL,
  SETTINGS_NOTIFICATION_LANGUAGE_DFAULT
} from '../constants/environment';

interface OperatorReplyPayload {
  data_token: string;
  channel_user_id: string;
  message: string;
}

const notificationTemplateCache = new NodeCache({ stdTTL: 604800 }); // 1 week

/**
 * Sends an operator reply to the API.
 */
async function sendBotNotification(payload: OperatorReplyPayload): Promise<string> {
  try {
    if (!BOT_NOTIFICATIONS_ENABLED) {
      Logger.info(`Bot notifications are disabled. Omitted payload: ${payload}`);
      return '';
    }

    const sendMsgEndpint = `${BOT_API_URL}/chatbot/conversations/send-message`;
    const response = await axios.post(sendMsgEndpint, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    Logger.log('API Response:', payload.channel_user_id, payload.message, response.data);
    return response.data;
  } catch (error) {
    Logger.error('Error sending operator reply:', (error as Error).message);
    throw error;
  }
}

/**
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
      Logger.info(`Push notifications are disabled, PUSH_ENABLED env variable: ${PUSH_ENABLED}.`);
      return true;
    }

    const user: IUser | null = await User.findOne({ phone_number: channelUserId });
    if (!user) {
      Logger.log(
        `Push notification not sent: Invalid user in the database for phone number ${channelUserId}`
      );
      return false;
    }

    let { walletEOA } = user;
    walletEOA = walletEOA.startsWith('0x') ? walletEOA : `0x${walletEOA}`;

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
      recipients: `eip155:${PUSH_NETWORK}:${walletEOA}`,
      channel: `eip155:${PUSH_NETWORK}:${PUSH_CHANNEL_ADDRESS}`,
      env: PUSH_ENVIRONMENT
    });

    Logger.log(
      `Push notification sent successfully to ${channelUserId},  ${walletEOA}:`,
      apiResponse.status,
      apiResponse.statusText
    );
    return true;
  } catch (error) {
    Logger.error(
      `Error sending Push Notification to ${channelUserId}:`,
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
}

/**
 * Gets user language based on the phone number.
 * @param phoneNumber
 * @returns
 */
export const getUserSettingsLanguage = async (phoneNumber: string): Promise<LanguageEnum> => {
  let language: LanguageEnum = SETTINGS_NOTIFICATION_LANGUAGE_DFAULT as LanguageEnum;
  try {
    const user: IUser | null = await User.findOne({ phone_number: phoneNumber });
    if (user && user.settings) {
      const userLanguage = user.settings.notifications.language;
      if (Object.values(LanguageEnum).includes(userLanguage as LanguageEnum)) {
        language = userLanguage as LanguageEnum;
      } else {
        Logger.warn(
          `Invalid language detected for user ${phoneNumber}, defaulting to ${SETTINGS_NOTIFICATION_LANGUAGE_DFAULT}`
        );
      }
    }
  } catch (error: unknown) {
    // avoid throw error
    Logger.error(
      `Error getting user settings language for ${phoneNumber}, error: ${(error as Error).message}`
    );
  }
  return language;
};

/**
 * Get Notification Template based on channel User Id and Notification Type
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
      Logger.log(`getting ${typeOfNotification} from cache`);
      return cachedTemplate as { title: string; message: string };
    }

    const userLanguage: LanguageEnum = await getUserSettingsLanguage(channelUserId);

    const notificationTemplates: NotificationTemplatesTypes | null =
      await getTemplate<ITemplateSchema>(templateEnum.NOTIFICATIONS);
    if (!notificationTemplates) {
      Logger.warn('Notifications Templates not found');
      return defaultNotification;
    }

    if (!Object.values(NotificationEnum).includes(typeOfNotification)) {
      Logger.warn(`Invalid notification type: ${typeOfNotification}`);
      return defaultNotification;
    }

    // @ts-expect-error 'expected type error'
    const template = notificationTemplates[typeOfNotification];

    if (!template) {
      Logger.warn(`Notification type ${typeOfNotification} not found`);
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
      `Error getting notification template ${typeOfNotification}, error: ${(error as Error).message}`
    );
  }
  return defaultNotification;
}

/**
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
    if (!user_private_key.startsWith('0x')) {
      user_private_key = `0x${user_private_key}`;
    }
    if (!user_address.startsWith('0x')) {
      user_address = `0x${user_address}`;
    }

    const signer = new ethers.Wallet(user_private_key);
    const subscriptionResponse = await PushAPIChannels.subscribe({
      signer,
      channelAddress: `eip155:${PUSH_NETWORK}:${PUSH_CHANNEL_ADDRESS}`,
      userAddress: `eip155:${PUSH_NETWORK}:${user_address}`,
      onSuccess: () => {
        Logger.log(`${user_address} successfully subscribed to Push Protocol Channel`);
      },
      onError: (error: unknown) => {
        Logger.error(`Error trying to subscribe ${user_address} to Push Protocol channel:`, error);
      },
      env: PUSH_ENVIRONMENT
    });

    Logger.log(`${user_address} Push Protocol Subscription Response:`, subscriptionResponse);
    return true;
  } catch (error) {
    // Avoid throwing an error if subscribing to the push channel fails
    Logger.error(
      `Error trying to subscribe ${user_address} to Push Channel:`,
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
}

/**
 * Sends wallet creation notification.
 * @param address_of_user
 * @param channel_user_id
 */
export async function sendWalletCreationNotification(
  address_of_user: string,
  channel_user_id: string
) {
  try {
    Logger.log(`Sending wallet creation notification to ${address_of_user}`);

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.wallet_creation
    );
    const formattedMessage = message.replace('[PREDICTED_WALLET_EOA_ADDRESS]', address_of_user);

    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
  } catch (error) {
    Logger.error('Error in sendWalletCreationNotification:', error);
    throw error;
  }
}

/**
 * Sends a notification for a transfer.
 * @param address_of_user
 * @param channel_user_id
 * @param from
 * @param amount
 * @param token
 * @returns
 */
export async function sendTransferNotification(
  address_of_user: string,
  channel_user_id: string,
  from: string | null,
  amount: string,
  token: string
): Promise<unknown> {
  try {
    Logger.log(`Sending transfer notification from ${from} to ${channel_user_id}`);
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

    const data = await sendBotNotification(payload);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('Error in sendTransferNotification:', error);
    throw error;
  }
}

/**
 * Sends a notification for a swap.
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
  transactionHash: string
): Promise<unknown> {
  try {
    Logger.log('Sending swap notification');
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

    const data = await sendBotNotification(payload);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('Error in sendSwapNotification:', error);
    throw error;
  }
}

/**
 * Sends a notification for minted certificates and on-chain memories.
 * @param address_of_user
 * @param channel_user_id
 * @param id
 * @returns
 */
export async function sendMintNotification(
  address_of_user: string,
  channel_user_id: string,
  id: string
): Promise<unknown> {
  try {
    Logger.log('Sending mint notification');

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

    const data = await sendBotNotification(payload);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('Error in sendMintNotification:', (error as Error).message);
    throw error;
  }
}

/**
 * Sends a notification for an outgoing transfer.
 * @param address_of_user
 * @param channel_user_id
 * @param walletTo
 * @param amount
 * @param token
 * @param txHash
 * @returns
 */
export async function sendOutgoingTransferNotification(
  address_of_user: string,
  channel_user_id: string,
  walletTo: string | null,
  amount: string,
  token: string,
  txHash: string
): Promise<unknown> {
  try {
    Logger.log('Sending outgoing transfer notification');
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const networkConfig: IBlockchain = await getNetworkConfig();

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.outgoing_transfer
    );
    const formattedMessage = message
      .replaceAll('[AMOUNT]', amount)
      .replaceAll('[TOKEN]', token)
      .replaceAll('[TO]', walletTo || '0X')
      .replaceAll('[EXPLORER]', networkConfig.explorer)
      .replaceAll('[TX_HASH]', txHash);

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message: formattedMessage
    };

    const data = await sendBotNotification(payload);
    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('Error in sendOutgoingTransferNotification:', error);
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
  channel_user_id: string
) {
  try {
    Logger.log(`Sending User Insufficient Balance notification to ${address_of_user}`);

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.user_balance_not_enough
    );

    const payload: OperatorReplyPayload = {
      data_token: BOT_DATA_TOKEN!,
      channel_user_id,
      message
    };

    const data = await sendBotNotification(payload);
    sendPushNotificaton(title, message, channel_user_id); // avoid await
    return data;
  } catch (error) {
    Logger.error('Error in sendUserInsufficientBalanceNotification:', error);
    throw error;
  }
}
