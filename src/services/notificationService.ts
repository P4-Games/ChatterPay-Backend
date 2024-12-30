import axios from 'axios';
import { ethers } from 'ethers';
import { channels as PushAPIChannels, payloads as PushAPIPayloads } from '@pushprotocol/restapi';

import { User, IUser } from '../models/user';
import { IBlockchain } from '../models/blockchain';
import { getNetworkConfig } from './networkService';
import { isValidPhoneNumber } from '../utils/validations';
import {
  BOT_API_URL,
  PUSH_NETWORK,
  BOT_DATA_TOKEN,
  PUSH_ENVIRONMENT,
  CHATTERPAY_DOMAIN,
  PUSH_CHANNEL_ADDRESS,
  PUSH_CHANNEL_PRIVATE_KEY,
  CHATTERPAY_NFTS_SHARE_URL
} from '../constants/environment';

interface OperatorReplyPayload {
  data_token: string;
  channel_user_id: string;
  message: string;
}

const notificationType = {
  Transfer: 'TRANSFER',
  Swap: 'SWAP',
  Mint: 'MINT',
  OutgoingTransfer: 'OUTGOING_TRANSFER',
  WalletCreation: 'WALLET_CREATION'
} as const;

type NotificationType = (typeof notificationType)[keyof typeof notificationType];

interface NotificationTemplate {
  title: { en: string; es: string; pt: string };
  message: { en: string; es: string; pt: string };
}

/**
 * Sends an operator reply to the API.
 */
async function sendBotNotification(payload: OperatorReplyPayload): Promise<string> {
  try {
    const sendMsgEndpint = `${BOT_API_URL}/chatbot/conversations/send-message`;
    const response = await axios.post(sendMsgEndpint, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    console.log('API Response:', payload.channel_user_id, payload.message, response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending operator reply:', (error as Error).message);
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
    const user: IUser | null = await User.findOne({ phone_number: channelUserId });
    if (!user) {
      console.log(
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

    console.log(
      `Push notification sent successfully to ${channelUserId},  ${walletEOA}:`,
      apiResponse.status,
      apiResponse.statusText
    );
    return true;
  } catch (error) {
    console.error(
      `Error sending Push Notification to ${channelUserId}:`,
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
}

function getNotiicationTemplate(channelUserId: string, typeOfNotification: NotificationType) {
  // TODO: read from bdd user language, shema "user.settings"
  const userLanguage = 'en';

  // TODO: read template from schema "templates.notifications"
  const templates: Record<NotificationType, NotificationTemplate> = {
    TRANSFER: {
      title: {
        en: 'Chatterpay: You received funds!',
        es: 'Chatterpay: ¡Recibiste fondos!',
        pt: 'Chatterpay: Você recebeu fundos!'
      },
      message: {
        en: '[FROM] sent you [AMOUNT] [TOKEN] 💸. It’s now available in your ChatterPay wallet! 🥳',
        es: '[FROM] te envió [AMOUNT] [TOKEN] 💸. ¡Ya están disponibles en tu billetera ChatterPay! 🥳',
        pt: '[FROM] enviou-lhe [AMOUNT] [TOKEN] 💸. Já está disponível na sua carteira ChatterPay! 🥳'
      }
    },
    SWAP: {
      title: {
        en: 'Chatterpay: Tokens swapped!',
        es: 'Chatterpay: ¡Intercambiaste tokens!',
        pt: 'Chatterpay: Tokens trocados!'
      },
      message: {
        en: '🔄 You swapped [AMOUNT] [TOKEN] for [RESULT] [OUTPUT_TOKEN]! 🔄\nCheck the transaction here: [EXPLORER]/tx/[TRANSACTION_HASH]',
        es: '🔄 Intercambiaste [AMOUNT] [TOKEN] por [RESULT] [OUTPUT_TOKEN]! 🔄\nPuedes ver la transacción aquí: [EXPLORER]/tx/[TRANSACTION_HASH]',
        pt: '🔄 Você trocou [AMOUNT] [TOKEN] por [RESULT] [OUTPUT_TOKEN]! 🔄\nVerifique a transação aqui: [EXPLORER]/tx/[TRANSACTION_HASH]'
      }
    },
    MINT: {
      title: {
        en: 'Chatterpay: NFT minted!',
        es: 'Chatterpay: ¡NFT emitido!',
        pt: 'Chatterpay: NFT cunhado!'
      },
      message: {
        en: '🎉 Your certificate has been successfully minted! 🎉\nYou can view it here: [NFTS_SHARE_URL]/[ID]',
        es: '🎉 ¡Tu certificado ha sido emitido exitosamente! 🎉\nPuedes verlo aquí: [NFTS_SHARE_URL]/[ID]',
        pt: '🎉 Seu certificado foi cunhado com sucesso! 🎉\nVocê pode visualizá-lo aqui: [NFTS_SHARE_URL]/[ID]'
      }
    },
    OUTGOING_TRANSFER: {
      title: {
        en: 'Chatterpay: You sent funds!',
        es: 'Chatterpay: ¡Enviaste fondos!',
        pt: 'Chatterpay: Você enviou fundos!'
      },
      message: {
        en: '💸 You sent [AMOUNT] [TOKEN] to [TO]! 💸\nCheck the transaction here: [EXPLORER]/tx/[TX_HASH]',
        es: '💸 Enviaste [AMOUNT] [TOKEN] a [TO]! 💸\nPuedes ver la transacción aquí: [EXPLORER]/tx/[TX_HASH]',
        pt: '💸 Você enviou [AMOUNT] [TOKEN] para [TO]! 💸\nVerifique a transação aqui: [EXPLORER]/tx/[TX_HASH]'
      }
    },
    WALLET_CREATION: {
      title: {
        en: 'Chatterpay: Wallet Created!',
        es: 'Chatterpay: ¡Billetera creada!',
        pt: 'Chatterpay: Carteira criada!'
      },
      message: {
        en: 'Your Wallet [PREDICTED_WALLET_EOA_ADDRESS] was created.',
        es: 'Tu billetera [PREDICTED_WALLET_EOA_ADDRESS] ha sido creada.',
        pt: 'Sua carteira [PREDICTED_WALLET_EOA_ADDRESS] foi criada.'
      }
    }
  };

  const template = templates[typeOfNotification];
  const language = ['en', 'es', 'pt'].includes(userLanguage) ? userLanguage : 'en';
  return {
    title: template.title[language as 'en' | 'es' | 'pt'],
    message: template.message[language as 'en' | 'es' | 'pt']
  };
}

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
        console.log(`${user_address} successfully subscribed to Push Protocol Channel`);
      },
      onError: (error: unknown) => {
        console.error(`Error trying to subscribe ${user_address} to Push Protocol channel:`, error);
      },
      env: PUSH_ENVIRONMENT
    });

    console.log(`${user_address} Push Protocol Subscription Response:`, subscriptionResponse);
    return true;
  } catch (error) {
    // Avoid throwing an error if subscribing to the push channel fails
    console.error(
      `Error trying to subscribe ${user_address} to Push Channel:`,
      error instanceof Error ? error.message : 'Unknown'
    );
    return false;
  }
}

/**
 * Sends wallet creation notification.
 */
export async function sendWalletCreationNotification(
  address_of_user: string,
  channel_user_id: string
) {
  try {
    console.log(`Sending wallet creation notification to ${address_of_user}`);

    const { title, message } = getNotiicationTemplate(
      channel_user_id,
      notificationType.WalletCreation
    );
    const formattedMessage = message.replace('[PREDICTED_WALLET_EOA_ADDRESS]', address_of_user);

    sendPushNotificaton(title, formattedMessage, channel_user_id); // avoid await
  } catch (error) {
    console.error('Error in sendWalletCreationNotification:', error);
    throw error;
  }
}

/**
 * Sends a notification for a transfer.
 */
export async function sendTransferNotification(
  address_of_user: string,
  channel_user_id: string,
  from: string | null,
  amount: string,
  token: string
): Promise<unknown> {
  try {
    console.log(`Sending transfer notification from ${from} to ${channel_user_id}`);
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const { title, message } = getNotiicationTemplate(channel_user_id, notificationType.Transfer);
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
    console.error('Error in sendTransferNotification:', error);
    throw error;
  }
}

/**
 * Sends a notification for a swap.
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
    console.log('Sending swap notification');
    const networkConfig: IBlockchain = await getNetworkConfig();

    const resultString: string = `${Math.round(parseFloat(result) * 1e4) / 1e4}`;
    const { title, message } = getNotiicationTemplate(channel_user_id, notificationType.Swap);

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
    console.error('Error in sendSwapNotification:', error);
    throw error;
  }
}

/**
 * Sends a notification for minted certificates and on-chain memories.
 */
export async function sendMintNotification(
  address_of_user: string,
  channel_user_id: string,
  id: string
): Promise<unknown> {
  try {
    console.log('Sending mint notification');

    const { title, message } = getNotiicationTemplate(channel_user_id, notificationType.Mint);
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
    console.error('Error in sendMintNotification:', (error as Error).message);
    throw error;
  }
}

/**
 * Sends a notification for an outgoing transfer.
 */
export async function sendOutgoingTransferNotification(
  address_of_user: string,
  channel_user_id: string,
  to: string | null,
  amount: string,
  token: string,
  txHash: string
): Promise<unknown> {
  try {
    console.log('Sending outgoing transfer notification');
    if (!isValidPhoneNumber(channel_user_id)) return '';

    const networkConfig: IBlockchain = await getNetworkConfig();

    const { title, message } = getNotiicationTemplate(
      channel_user_id,
      notificationType.OutgoingTransfer
    );
    const formattedMessage = message
      .replaceAll('[AMOUNT]', amount)
      .replaceAll('[TOKEN]', token)
      .replaceAll('[TO]', to || '0X')
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
    console.error('Error in sendOutgoingTransferNotification:', error);
    throw error;
  }
}
