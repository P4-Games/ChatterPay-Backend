import { channels as PushAPIChannels, payloads as PushAPIPayloads } from '@pushprotocol/restapi';
import { ethers } from 'ethers';
import {
  CHATTERPAY_DOMAIN,
  DEFAULT_CHAIN_ID,
  PUSH_CHANNEL_ADDRESS,
  PUSH_CHANNEL_PRIVATE_KEY,
  PUSH_ENABLED,
  PUSH_ENVIRONMENT,
  PUSH_NETWORK
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import type { IUser, IUserWallet } from '../../models/userModel';
import { mongoUserService } from '../mongo/mongoUserService';

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

export const pushService = {
  /**
   * Subscribe User To Push Channel
   *
   * @param user_p
   * @param user_address
   * @returns
   */
  subscribeToPushChannel: async (user_p: string, user_address: string): Promise<boolean> => {
    try {
      let userPFormatted = user_p;
      let userAddressFormatted = user_address;

      if (!user_p.startsWith('0x')) {
        userPFormatted = `0x${user_p}`;
      }
      if (!user_address.startsWith('0x')) {
        userAddressFormatted = `0x${user_address}`;
      }

      const signer = new ethers.Wallet(userPFormatted);
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
  },

  /**
   * Send Push Notificaiton
   *
   * @param title Notification Title
   * @param msg Notification Message
   * @param type 1 -> Broadcast, 3 -> Targeted
   * @param identityType // 0 -> Minimal, 2 -> Direct Payload
   */
  sendPushNotificaton: async (
    title: string,
    msg: string,
    channelUserId: string,
    type: number = 3,
    identityType: number = 2
  ): Promise<boolean> => {
    try {
      if (!PUSH_ENABLED) {
        Logger.info('sendPushNotificaton', `Push notifications are disabled.`);
        return true;
      }

      const user: IUser | null = await mongoUserService.getUser(channelUserId);
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
};
