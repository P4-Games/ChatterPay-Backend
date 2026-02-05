import { BOT_DATA_TOKEN, CHATTERPAY_NFTS_SHARE_URL } from '../config/constants';
import { formatIdentifierWithOptionalName } from '../helpers/formatHelper';
import { Logger } from '../helpers/loggerHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { isValidPhoneNumber } from '../helpers/validationHelper';

import type { IBlockchain } from '../models/blockchainModel';
import {
  type ITemplateSchema,
  NotificationEnum,
  type NotificationTemplatesTypes,
  type NotificationUtilityConfigType
} from '../models/templateModel';
import type { AaveSupplyInfo } from '../types/aaveType';
import type { chatizaloOperatorReply } from '../types/chatizaloType';
import { CacheNames, type NotificationLanguage } from '../types/commonType';
import { cacheService } from './cache/cacheService';
import { chatizaloService } from './chatizalo/chatizaloService';
import type { RegisterOperationResult } from './chatterpointsService';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { mongoNotificationService } from './mongo/mongoNotificationServices';
import { mongoTemplateService, templateEnum } from './mongo/mongoTemplateService';
import { mongoUserService } from './mongo/mongoUserService';

function normalizePreferredLanguage(language: string | null | undefined): 'es' | 'pt' | 'en' {
  const normalized = (language ?? '').trim().toLowerCase();
  if (normalized.startsWith('es')) return 'es';
  if (normalized.startsWith('pt')) return 'pt';
  return 'en';
}

async function getNotificationUtilityConfig(
  typeOfNotification: NotificationEnum
): Promise<NotificationUtilityConfigType | undefined> {
  const notificationTemplates: NotificationTemplatesTypes | null =
    await mongoTemplateService.getTemplate<ITemplateSchema>(templateEnum.NOTIFICATIONS);
  if (!notificationTemplates) return undefined;

  // @ts-expect-error 'expected type error'
  const template = notificationTemplates[typeOfNotification];

  return template?.utility;
}

/**
 * Retrieves a notification template based on the user's channel ID and the specified notification type.
 *
 * @param channelUserId - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param typeOfNotification - The type of notification to retrieve, defined by `NotificationEnum`.
 * @returns A Promise resolving to an object containing the notification's title and message.
 */
export async function getNotificationTemplate(
  channelUserId: string,
  typeOfNotification: NotificationEnum
): Promise<{ title: string; message: string }> {
  const defaultNotification = { title: 'Chatterpay Message', message: '' };
  try {
    if (!Object.values(NotificationEnum).includes(typeOfNotification)) {
      Logger.warn('getNotificationTemplate', `Invalid notification type: ${typeOfNotification}`);
      return defaultNotification;
    }

    const userLanguage: NotificationLanguage =
      await mongoUserService.getUserSettingsLanguage(channelUserId);

    const cacheKey = `${typeOfNotification}:${userLanguage}`;
    const cachedTemplate = cacheService.get(CacheNames.NOTIFICATION, `${cacheKey}`);
    if (cachedTemplate) {
      Logger.log('getNotificationTemplate', `getting ${cacheKey} from cache`);
      return cachedTemplate as { title: string; message: string };
    }

    const notificationTemplates: NotificationTemplatesTypes | null =
      await mongoTemplateService.getTemplate<ITemplateSchema>(templateEnum.NOTIFICATIONS);
    if (!notificationTemplates) {
      Logger.warn('getNotificationTemplate', 'Notifications Templates not found');
      return defaultNotification;
    }

    // @ts-expect-error 'expected type error'
    const template = notificationTemplates[typeOfNotification];

    if (!template) {
      Logger.warn('getNotificationTemplate', `Notification type ${typeOfNotification} not found`);
      return defaultNotification;
    }

    const availableTitle = template.title?.[userLanguage];
    const availableMessage = template.message?.[userLanguage];
    const fallbackLanguage =
      (Object.keys(template.title ?? {})[0] as NotificationLanguage | undefined) ?? userLanguage;

    const result = {
      title: availableTitle ?? template.title?.[fallbackLanguage] ?? defaultNotification.title,
      message:
        availableMessage ?? template.message?.[fallbackLanguage] ?? defaultNotification.message
    };
    cacheService.set(CacheNames.NOTIFICATION, `${cacheKey}`, result);

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
 * Sends a notification when a user's wallet is successfully created.
 *
 * @param user_wallet_proxy - The blockchain address of the newly created wallet (Proxy).
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param network_name - The network name.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendWalletCreationNotification(
  user_wallet_proxy: string,
  channel_user_id: string,
  network_name: string
) {
  try {
    Logger.log(
      'sendWalletCreationNotification',
      `Sending wallet creation notification to ${channel_user_id}, ${user_wallet_proxy}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.wallet_creation
    );
    const formattedMessage = message
      .replace('[WALLET_ADDRESS]', user_wallet_proxy)
      .replace('[NETWORK_NAME]', network_name);

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.wallet_creation,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader: ''
    };

    await persistAndSendNotification(sendAndPersistParams);
  } catch (error) {
    Logger.error('sendWalletCreationNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when a user's wallet already exists.
 *
 * @param user_wallet_proxy - The blockchain address of the already existing wallet (Proxy).
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param network_name - The network name.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendWalletAlreadyExistsNotification(
  user_wallet_proxy: string,
  channel_user_id: string,
  network_name: string
) {
  try {
    Logger.log(
      'sendWalletAlreadyExistsNotification',
      `Sending wallet already exists notification to ${channel_user_id}, ${user_wallet_proxy}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.wallet_already_exists
    );
    const formattedMessage = message
      .replace('[WALLET_ADDRESS]', user_wallet_proxy)
      .replace('[NETWORK_NAME]', network_name);

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.wallet_already_exists,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader: ''
    };

    await persistAndSendNotification(sendAndPersistParams);
  } catch (error) {
    Logger.error('sendWalletAlreadyExistsNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for a received transfer.
 *
 * @param phoneNumberFrom - Sender's phone number.
 * @param nameFrom - Sender's name (optional).
 * @param phoneNumberTo - Recipient's phone number.
 * @param amount - Amount received.
 * @param token - Token symbol or identifier (e.g., ETH, USDT).
 * @param user_notes - User notes associated with the transaction.
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendReceivedTransferNotification(
  phoneNumberFrom: string,
  nameFrom: string | null,
  phoneNumberTo: string,
  amount: string,
  token: string,
  notes: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log(
      'sendReceivedTransferNotification',
      `Sending received transfer notification from ${phoneNumberFrom} to ${phoneNumberTo}`
    );
    if (!isValidPhoneNumber(phoneNumberTo)) return '';

    const hasNotes = notes.trim().length > 0;
    const notificationType = hasNotes
      ? NotificationEnum.incoming_transfer_w_note
      : NotificationEnum.incoming_transfer;

    const { title, message } = await getNotificationTemplate(phoneNumberTo, notificationType);

    const formatMessage = (fromNumberAndName: string) =>
      message
        .replaceAll('[FROM]', fromNumberAndName)
        .replaceAll('[AMOUNT]', amount)
        .replaceAll('[TOKEN]', token)
        .replaceAll('[NOTES]', hasNotes ? `\n('${notes}')` : '');

    const fromNumberAndName = formatIdentifierWithOptionalName(phoneNumberFrom, nameFrom, false);
    const fromNumberAndNameMasked = formatIdentifierWithOptionalName(
      phoneNumberFrom,
      nameFrom,
      true
    );

    const formattedMessageBot = formatMessage(fromNumberAndName);
    const formattedMessagePush = formatMessage(fromNumberAndNameMasked);

    const utilityConfig = await getNotificationUtilityConfig(notificationType);
    const utilityEnabled =
      utilityConfig?.enabled === true &&
      typeof utilityConfig.template_key === 'string' &&
      utilityConfig.template_key.length > 0 &&
      Array.isArray(utilityConfig.param_order) &&
      utilityConfig.param_order.length > 0;

    const from = nameFrom ? `${phoneNumberFrom} (${nameFrom})` : phoneNumberFrom;
    const templateParamsValues: Record<string, string> = {
      from,
      amount,
      token,
      ...(hasNotes ? { notes } : {})
    };

    const utilityParamOrder = hasNotes
      ? utilityConfig?.param_order
      : utilityConfig?.param_order.filter((param) => param !== 'notes');

    const sendAndPersistParams: SendAndPersistParams = {
      to: phoneNumberTo,
      messageBot: formattedMessageBot,
      messagePush: formattedMessagePush,
      template: notificationType,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader,
      ...(utilityEnabled
        ? {
            message_kind: 'utility' as const,
            preferred_language: normalizePreferredLanguage(
              await mongoUserService.getUserSettingsLanguage(phoneNumberTo)
            ),
            template_key: utilityConfig.template_key,
            template_params: utilityConfig.param_order.map(
              (param) => templateParamsValues[param] ?? ''
            )
          }
        : {})
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendReceivedTransferNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for a received transfer from an external wallet.
 *
 * @param phoneNumberFrom - Sender's phone number (external wallet placeholder).
 * @param nameFrom - Sender's name (optional).
 * @param phoneNumberTo - Recipient's phone number.
 * @param amount - Amount received.
 * @param token - Token symbol or identifier (e.g., ETH, USDT).
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendReceivedExternalTransferNotification(
  phoneNumberFrom: string,
  nameFrom: string | null,
  phoneNumberTo: string,
  amount: string,
  token: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log(
      'sendReceivedExternalTransferNotification',
      `Sending received external transfer notification from ${phoneNumberFrom} to ${phoneNumberTo}`
    );
    if (!isValidPhoneNumber(phoneNumberTo)) return '';

    const { title, message } = await getNotificationTemplate(
      phoneNumberTo,
      NotificationEnum.incoming_transfer_external
    );

    const formatMessage = (fromNumberAndName: string) =>
      message
        .replaceAll('[FROM]', fromNumberAndName)
        .replaceAll('[AMOUNT]', amount)
        .replaceAll('[TOKEN]', token);

    const fromNumberAndName = formatIdentifierWithOptionalName(phoneNumberFrom, nameFrom, false);
    const fromNumberAndNameMasked = formatIdentifierWithOptionalName(
      phoneNumberFrom,
      nameFrom,
      true
    );

    const formattedMessageBot = formatMessage(fromNumberAndName);
    const formattedMessagePush = formatMessage(fromNumberAndNameMasked);

    const utilityConfig = await getNotificationUtilityConfig(
      NotificationEnum.incoming_transfer_external
    );
    const utilityEnabled =
      utilityConfig?.enabled === true &&
      typeof utilityConfig.template_key === 'string' &&
      utilityConfig.template_key.length > 0 &&
      Array.isArray(utilityConfig.param_order) &&
      utilityConfig.param_order.length > 0;

    const from = nameFrom ? `${phoneNumberFrom} (${nameFrom})` : phoneNumberFrom;
    const templateParamsValues: Record<string, string> = {
      from,
      amount,
      token
    };

    const sendAndPersistParams: SendAndPersistParams = {
      to: phoneNumberTo,
      messageBot: formattedMessageBot,
      messagePush: formattedMessagePush,
      template: NotificationEnum.incoming_transfer_external,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader,
      ...(utilityEnabled
        ? {
            message_kind: 'utility' as const,
            preferred_language: normalizePreferredLanguage(
              await mongoUserService.getUserSettingsLanguage(phoneNumberTo)
            ),
            template_key: utilityConfig.template_key,
            template_params: (utilityParamOrder ?? []).map(
              (param) => templateParamsValues[param] ?? ''
            )
          }
        : {})
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendReceivedExternalTransferNotification', error);
    throw error;
  }
}

/**
 * Sends a notification for a completed token swap.
 *
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param token - Symbol or identifier of the input token being swapped.
 * @param amount - Amount of the input token swapped.
 * @param result - Amount of the output token received.
 * @param outputToken - Symbol or identifier of the token received after the swap.
 * @param transactionHash - Blockchain transaction hash of the swap operation.
 * @param chatterpointsOpResult Chatterpoints Operation Result.
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendSwapNotification(
  channel_user_id: string,
  token: string,
  amount: string,
  result: string,
  outputToken: string,
  transactionHash: string,
  chatterpointsOpResult: RegisterOperationResult | null,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log('sendSwapNotification', 'Sending swap notification');
    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.swap
    );

    let formattedMessage = message
      .replaceAll('[AMOUNT]', amount)
      .replaceAll('[TOKEN]', token)
      .replaceAll('[RESULT]', result)
      .replaceAll('[OUTPUT_TOKEN]', outputToken)
      .replaceAll('[EXPLORER]', networkConfig.explorer)
      .replaceAll('[TRANSACTION_HASH]', transactionHash);

    if (chatterpointsOpResult && chatterpointsOpResult.operation.points > 0) {
      const { message: messageChpTemplate } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.chatterpoints_operation
      );
      const messageChp = messageChpTemplate.replaceAll(
        '[POINTS]',
        chatterpointsOpResult.operation.points.toString()
      );

      formattedMessage = `${formattedMessage}\n\n${messageChp}`;
    }
    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.swap,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);

    return data;
  } catch (error) {
    Logger.error('sendSwapNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when a certificate or on-chain memory has been minted.
 *
 * @param address_of_user - The blockchain address of the user.
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param id - The unique identifier of the minted certificate or memory.
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendMintNotification(
  address_of_user: string,
  channel_user_id: string,
  id: string,
  traceHeader?: string
): Promise<unknown> {
  try {
    Logger.log('sendMintNotification', `Sending mint notification to ${channel_user_id}`);

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.mint
    );
    const formattedMessage = message
      .replaceAll('[ID]', id)
      .replaceAll('[NFTS_SHARE_URL]', CHATTERPAY_NFTS_SHARE_URL);

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.mint,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendMintNotification', (error as Error).message);
    throw error;
  }
}

/**
 * Sends a notification for an outgoing transfer.
 *
 * @param phoneNumberFrom - Sender's phone number.
 * @param phoneNumberTo - Recipient's phone number.
 * @param toName - Recipient's name.
 * @param amount - Amount transferred.
 * @param token - Token symbol or identifier (e.g., ETH, USDT).
 * @param notes - User notes associated with the transaction.
 * @param txHash - Blockchain transaction hash of the transfer.
 * @param chatterpointsOpResult - Chatterpoints operation result.
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 * @returns A Promise resolving to the result of the notification operation.
 */
export async function sendOutgoingTransferNotification(
  phoneNumberFrom: string,
  phoneNumberTo: string,
  toName: string,
  amount: string,
  token: string,
  notes: string,
  txHash: string,
  chatterpointsOpResult: RegisterOperationResult | null,
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

    let messageChp: string | null = null;
    if (chatterpointsOpResult && chatterpointsOpResult.operation.points > 0) {
      const { message: messageChpTemplate } = await getNotificationTemplate(
        phoneNumberFrom,
        NotificationEnum.chatterpoints_operation
      );
      messageChp = messageChpTemplate.replaceAll(
        '[POINTS]',
        chatterpointsOpResult.operation.points.toString()
      );
    }

    const formatMessage = (toNumberAndName: string) => {
      let base = message
        .replaceAll('[AMOUNT]', amount)
        .replaceAll('[TOKEN]', token)
        .replaceAll('[TO]', toNumberAndName)
        .replaceAll('[EXPLORER]', networkConfig.explorer)
        .replaceAll('[TX_HASH]', txHash)
        .replaceAll('[NOTES]', notes ? `\n('${notes}')` : '');
      if (messageChp) {
        base = `${base}\n\n${messageChp}`;
      }
      return base;
    };

    const toNumberAndName = formatIdentifierWithOptionalName(phoneNumberTo, toName, false);
    const toNumberAndNameMasked = formatIdentifierWithOptionalName(phoneNumberTo, toName, true);

    const formattedMessageBot = formatMessage(toNumberAndName);
    const formattedMessagePush = formatMessage(toNumberAndNameMasked);

    const sendAndPersistParams: SendAndPersistParams = {
      to: phoneNumberFrom,
      messageBot: formattedMessageBot,
      messagePush: formattedMessagePush,
      template: NotificationEnum.outgoing_transfer,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendOutgoingTransferNotification', error);
    throw error;
  }
}

export async function sendAAVECreateSuplyNotification(
  channel_user_id: string,
  amount: string,
  token: string,
  txHash: string
): Promise<unknown> {
  try {
    Logger.log('sendAAVECreateSuplyNotification', 'Sending AAVE create Suply notification');
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.aave_supply_created
    );

    const formattedMessage = message
      .replace('[AMOUNT]', amount.toString())
      .replace('[TOKEN]', token.toString())
      .replace('[EXPLORER]', networkConfig.explorer)
      .replace('[TX_HASH]', txHash);

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.aave_supply_created,
      sendPush: false,
      sendBot: true,
      title,
      traceHeader: ''
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendAAVECreateSuplyNotification', error);
    throw error;
  }
}

export async function sendAAVERemoveSuplyNotification(
  channel_user_id: string,
  amount: string,
  token: string,
  txHash: string
): Promise<unknown> {
  try {
    Logger.log('sendAAVERemoveSuplyNotification', 'Sending AAVE remove Suply notification');
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.aave_supply_modified
    );

    const formattedMessage = message
      .replace('[AMOUNT]', amount.toString())
      .replace('[TOKEN]', token.toString())
      .replace('[EXPLORER]', networkConfig.explorer)
      .replace('[TX_HASH]', txHash);

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.aave_supply_modified,
      sendPush: false,
      sendBot: true,
      title,
      traceHeader: ''
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendAAVESuplyNotification', error);
    throw error;
  }
}

export async function sendAaveSupplyInfoNotification(
  channel_user_id: string,
  supplyInfo: AaveSupplyInfo
): Promise<unknown> {
  try {
    Logger.log('sendAaveSupplyInfoNotification', 'Sending AAVE Suply Info notification');
    if (!isValidPhoneNumber(channel_user_id)) return '';

    let title = '';
    let formattedMessage = '';

    if (supplyInfo) {
      const { title: tplTitle, message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.aave_supply_info
      );

      title = tplTitle;
      formattedMessage = message
        .replace('[ATOKEN_BALANCE]', supplyInfo.aTokenBalance.toString())
        .replace('[ATOKEN_SYMBOL]', supplyInfo.aTokenSymbol.toString())
        .replace('[SUPPLY_APY]', supplyInfo.supplyAPY.toString());
    } else {
      const { title: tplTitle, message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.aave_supply_info_no_data
      );

      title = tplTitle;
      formattedMessage = message;
    }

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.aave_supply_info,
      sendPush: false,
      sendBot: true,
      title,
      traceHeader: ''
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendAaveSupplyInfoNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when user balance not enough
 *
 * @param address_of_user - The blockchain address of the user.
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
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

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: message,
      messagePush: message,
      template: NotificationEnum.user_balance_not_enough,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendUserInsufficientBalanceNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when blockchain conditions are invalid.
 *
 * @param address_of_user - The blockchain address of the user.
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
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

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: message,
      messagePush: message,
      template: NotificationEnum.no_valid_blockchain_conditions,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendNoValidBlockchainConditionsNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when an internal error occurs.
 *
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param lastBotMsgDelaySeconds - (Optional) Delay in seconds since the last bot message was sent. Defaults to 0.
 * @param details - (Optional) Additional details about the error.
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 */
export async function sendInternalErrorNotification(
  channel_user_id: string,
  lastBotMsgDelaySeconds: number = 0,
  details?: string,
  traceHeader?: string
) {
  try {
    if (lastBotMsgDelaySeconds > 0) {
      // This is here because the user should receive the "we are processing your operation" message first,
      // and in case of an error, the error message (this function) afterward. The first message is sent
      // through a broader channel (which takes longer), while the second one may take less time.
      // Hence, this delay is needed, which is controlled by a queryParam in chat_functions of Chatizalo.
      Logger.log(
        'sendInternalErrorNotification',
        `Delaying bot notification ${lastBotMsgDelaySeconds} seconds.`
      );
      await delaySeconds(lastBotMsgDelaySeconds);
    }

    Logger.log(
      'sendInternalErrorNotification',
      `Sending internal error notification to ${channel_user_id}, details: ${details || 'no details'}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.internal_error
    );

    const finalMessage = details ? `${message}\n\n(Details: ${details})` : message;

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: finalMessage,
      messagePush: finalMessage,
      template: NotificationEnum.internal_error,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendInternalErrorNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when the user has concurrent operations.
 *
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 */
export async function sendConcurrecyOperationNotification(
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

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: message,
      messagePush: message,
      template: NotificationEnum.concurrent_operation,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('SendConcurrecyOperationNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when the user reaches the daily limit for an operation.
 *
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 */
export async function sendDailyLimitReachedNotification(
  channel_user_id: string,
  traceHeader?: string
) {
  try {
    Logger.log(
      'sendDailyLimitReachedNotification',
      `Sending notification: daily limit reached for operation to ${channel_user_id}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.daily_limit_reached
    );

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: message,
      messagePush: message,
      template: NotificationEnum.daily_limit_reached,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendDailyLimitReachedNotification', error);
    throw error;
  }
}

/**
 * Sends a notification when the user attempts to perform an operation outside the allowed limits.
 *
 * @param channel_user_id - The user's identifier within the communication channel (e.g., Telegram or WhatsApp).
 * @param tokenSymbol - The symbol of the token the user is attempting to operate with.
 * @param minLimit - The minimum allowed limit for the operation.
 * @param maxLimit - The maximum allowed limit for the operation.
 * @param traceHeader - (Optional) Trace identifier for debugging or logging purposes.
 */
export async function sendOperationOutsideLimitsNotification(
  channel_user_id: string,
  tokenSymbol: string,
  minLimit: number,
  maxLimit: number,
  traceHeader?: string
) {
  try {
    Logger.log(
      'sendOperationOutsideLimitsNotification',
      `Sending notification: operation outside limits for ${tokenSymbol} to ${channel_user_id}`
    );

    const { title, message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.amount_outside_limits
    );

    const formattedMessage = message
      .replace('[LIMIT_MIN]', minLimit.toString())
      .replace('[LIMIT_MAX]', maxLimit.toString());

    const sendAndPersistParams: SendAndPersistParams = {
      to: channel_user_id,
      messageBot: formattedMessage,
      messagePush: formattedMessage,
      template: NotificationEnum.amount_outside_limits,
      sendPush: true,
      sendBot: true,
      title,
      traceHeader
    };

    const data = await persistAndSendNotification(sendAndPersistParams);
    return data;
  } catch (error) {
    Logger.error('sendOperationOutsideLimitsNotification', error);
    throw error;
  }
}

/* ----------------------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------------------- */

interface SendAndPersistParams {
  to: string;
  messageBot: string;
  messagePush: string;
  template: string;
  sendPush?: boolean;
  sendBot?: boolean;
  title?: string; // solo para push
  traceHeader?: string;
  message_kind?: chatizaloOperatorReply['message_kind'];
  preferred_language?: chatizaloOperatorReply['preferred_language'];
  template_key?: chatizaloOperatorReply['template_key'];
  template_params?: chatizaloOperatorReply['template_params'];
}

/**
 * Persists a notification in MongoDB (always with media: 'INTERNAL'),
 * then optionally sends it via WhatsApp (bot) and/or Push.
 *
 * @param {string} to - Recipient identifier (e.g., phone number).
 * @param {string} messageBot - Message content to be sent and stored.
 * @param {string} messagePush - Message content to be sent and stored.
 * @param {string} template - Template identifier used for the notification.
 * @param {boolean} [sendPush=false] - Whether to send the notification via Push.
 * @param {boolean} [sendBot=false] - Whether to send the notification via WhatsApp bot.
 * @param {string} [title] - Title for the Push notification (required if sendPush is true).
 * @param {string} [traceHeader] - Optional trace header for observability.
 *
 * @returns {Promise<string | null>} The bot service response if sent via WhatsApp, otherwise null.
 */
export async function persistAndSendNotification({
  to,
  messageBot,
  messagePush,
  template,
  sendPush = false,
  sendBot = false,
  title,
  traceHeader,
  message_kind,
  preferred_language,
  template_key,
  template_params
}: SendAndPersistParams): Promise<string | null> {
  const sent_date = new Date();

  try {
    const data: string | null = null;

    // 1. Persist always with media INTERNAL
    await mongoNotificationService.createNotification({
      to,
      message: messageBot,
      template,
      media: 'INTERNAL',
      sent_date,
      read_date: undefined,
      deleted_date: undefined
    });

    // 2. Send via Chatizalo if flag is true
    if (sendBot) {
      const payload: chatizaloOperatorReply = {
        data_token: BOT_DATA_TOKEN!,
        channel_user_id: to,
        message: messageBot,
        ...(message_kind !== undefined ? { message_kind } : {}),
        ...(preferred_language !== undefined ? { preferred_language } : {}),
        ...(template_key !== undefined ? { template_key } : {}),
        ...(template_params !== undefined ? { template_params } : {})
      };
      await chatizaloService.sendBotNotification(payload, traceHeader);
    }

    return data;
  } catch (error) {
    Logger.error('sendAndPersistNotification', error);
    throw error;
  }
}

/**
 * Persists a notification in MongoDB with media: 'INTERNAL',
 * without sending it via bot or push.
 *
 * @param {string} to - Recipient identifier (e.g., phone number).
 * @param {string} message - Message content to store.
 * @param {string} template - Template identifier.
 * @returns {Promise<void>}
 */
export async function persistNotification(
  to: string,
  message: string,
  template: string
): Promise<void> {
  const sent_date = new Date();

  try {
    await mongoNotificationService.createNotification({
      to,
      message,
      template,
      media: 'INTERNAL',
      sent_date,
      read_date: undefined,
      deleted_date: undefined
    });
  } catch (error) {
    Logger.error('persistNotification', error);
  }
}
