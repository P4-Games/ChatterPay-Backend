import axios from 'axios';
import { ethers } from 'ethers';
import { payloads as PushAPIPayloads, channels as PushAPIChannels } from '@pushprotocol/restapi';

import { IBlockchain } from '../models/blockchain';
import { isValidPhoneNumber } from '../utils/validations';
import { getNetworkConfig } from '../services/networkService';
import { BOT_API_URL, PUSH_NETWORK, BOT_DATA_TOKEN, PUSH_ENVIRONMENT, PUSH_CHANNEL_ADDRESS, PUSH_CHANNEL_PRIVATE_KEY } from '../constants/environment';

interface OperatorReplyPayload {
    data_token: string;
    channel_user_id: string;
    message: string;
}

/**
 * Sends an operator reply to the API.
 */
async function sendBotNotification(payload: OperatorReplyPayload): Promise<string> {
    try {
        const sendMsgEndpint = `${BOT_API_URL}/chatbot/conversations/send-message`;

        console.log(sendMsgEndpint);

        const response = await axios.post(sendMsgEndpint, payload, {
            headers: {
                'Content-Type': 'application/json',
            },
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
    title: string, msg: string, notifyToAddress: string, 
    type: number = 3, identityType: number = 2) : Promise<boolean> {

    try {
        const signer = new ethers.Wallet(PUSH_CHANNEL_PRIVATE_KEY)
        if (!notifyToAddress.startsWith('0x')) {
            notifyToAddress = `0x${notifyToAddress}`;
        }
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
                cta: 'https://chatterpay.net',
                img: 'https://chatterpay.net/assets/images/home/logo.png'
            },
            recipients: `eip155:${PUSH_NETWORK}:${notifyToAddress}`, 
            channel: `eip155:${PUSH_NETWORK}:${PUSH_CHANNEL_ADDRESS}`, 
            env: PUSH_ENVIRONMENT
        })

        console.log(`Push notification sent successfully to ${notifyToAddress}:`, apiResponse.status, apiResponse.statusText);
        return true;
    } catch (error: unknown) {
        console.error(`Error sending Push Notification to ${notifyToAddress}:`, error);
        return false;
    }
    
}

export async function subscribeToPushChannel(user_private_key: string, user_address: string): Promise<boolean> {
    try {
        if (!user_private_key.startsWith('0x')) {
            user_private_key = `0x${user_private_key}`;
        }
        if (!user_address.startsWith('0x')) {
            user_address = `0x${user_address}`;
        }

        const signer = new ethers.Wallet(user_private_key)
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
        })

        console.log(`${user_address} Push Protocol Subscription Response:`, subscriptionResponse);
        return true;

    } catch (error) {
        console.error('Error:', error)
        return false;
    }
}

/**
 * Sends a notification for a transfer.
 */
export async function sendTransferNotification(
    channel_user_id: string,
    from: string | null,
    amount: string,
    token: string,
): Promise<string> {
    try {
        console.log(`Sending transfer notification from ${from} to ${channel_user_id}`);

        if (!isValidPhoneNumber(channel_user_id)) return "";

        const message = from ?
            `${from} te envió ${amount} ${token} 💸. Ya estan disponibles en tu billetera ChatterPay! 🥳` :
            `Recibiste ${amount} ${token} 💸. Ya estan disponibles en tu billetera ChatterPay! 🥳`;

        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message
        };

        const data = await sendBotNotification(payload);

        console.log('Notification sent:', data);
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
    transactionHash: string,
): Promise<void> {
    try {
        console.log('Sending swap notification');
        const networkConfig: IBlockchain = await getNetworkConfig();

        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message: `🔄 Intercambiaste ${amount} ${token} por ${Math.round(parseFloat(result) * 1e4) / 1e4} ${outputToken}! 🔄 \n Puedes ver la transacción aquí: ${networkConfig.explorer}/tx/${transactionHash}`,
        };
        await sendBotNotification(payload);
    } catch (error) {
        console.error('Error in sendSwapNotification:', error);
        throw error;
    }
}

/**
 * Sends a notification for minted certificates and on-chain memories.
 */
export async function sendMintNotification(address_of_user:string, channel_user_id: string, id: string): Promise<void> {
    try {
        console.log('Sending mint notification');
        const title = 'Chatterpay: NFT minted!'
        const message = `🎉 ¡Tu certificado ha sido emitido exitosamente! 🎉, podes verlo en: https://chatterpay.net/nfts/share/${id}`

        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message
        };
        await sendBotNotification(payload);
        sendPushNotificaton(title, message, address_of_user) // avoid await 
    } catch (error) {
        console.error('Error in sendMintNotification:', (error as Error).message);
        throw error;
    }
}

/**
 * Sends a notification for an outgoing transfer.
 */
export async function sendOutgoingTransferNotification(
    channel_user_id: string,
    to: string | null,
    amount: string,
    token: string,
    txHash: string,
): Promise<string> {
    try {
        console.log('Sending outgoing transfer notification');

        if (!isValidPhoneNumber(channel_user_id)) return "";

        const networkConfig: IBlockchain = await getNetworkConfig();

        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message: `💸 Enviaste ${amount} ${token} a ${to}! 💸 \n Puedes ver la transacción aquí: ${networkConfig.explorer}/tx/${txHash}`,
        };
        const data = await sendBotNotification(payload);
        console.log('Notification sent:', data);
        return data;
    } catch (error) {
        console.error('Error in sendOutgoingTransferNotification:', error);
        throw error;
    }
}
