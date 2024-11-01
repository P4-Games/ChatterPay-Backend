import axios from 'axios';

import { IBlockchain } from '../models/blockchain';
import { networkChainIds } from '../constants/contracts';
import { isValidPhoneNumber } from '../utils/validations';
import { getNetworkConfig } from '../services/networkService';
import { BOT_API_URL, BOT_DATA_TOKEN } from '../constants/environment';

interface OperatorReplyPayload {
    data_token: string;
    channel_user_id: string;
    message: string;
}

/**
 * Sends an operator reply to the API.
 */
async function sendBotMessage(payload: OperatorReplyPayload): Promise<string> {
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

        if(!isValidPhoneNumber(channel_user_id)) return "";

        const message = from ? 
            `${from} te envió ${amount} ${token} 💸. Ya estan disponibles en tu billetera ChatterPay! 🥳` :
            `Recibiste ${amount} ${token} 💸. Ya estan disponibles en tu billetera ChatterPay! 🥳`;
        
        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message
        };

        const data = await sendBotMessage(payload);

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
            message: `🔄 Intercambiaste ${amount} ${token} por ${Math.round(parseFloat(result) * 1e2) / 1e2} ${outputToken}! 🔄 \n Puedes ver la transacción aquí: ${networkConfig.explorer}/tx/${transactionHash}`,
        };
        await sendBotMessage(payload);
    } catch (error) {
        console.error('Error in sendSwapNotification:', error);
        throw error;
    }
}

/**
 * Sends a notification for minting certificates in-progress and on-chain memories.
 */
/*
export async function sendMintInProgressNotification(channel_user_id: string): Promise<void> {
    try {
        console.log('Sending mint-in progress notification');

        const payload: OperatorReplyPayload = {
            data_token: `${botDataToken}`,
            channel_user_id,
            message: `El certificado en NFT está siendo generado. Por favor, espera un momento. Te notificaré cuando esté listo.`,
        };
        await sendBotMessage(payload);
    } catch (error) {
        console.error('Error in sendMintInProgressNotification:', error.message);
        throw error;
    }
}
*/

/**
 * Sends a notification for minted certificates and on-chain memories.
 */
export async function sendMintNotification(channel_user_id: string, id: string): Promise<void> {
    try {
        console.log('Sending mint notification');
        const networkConfig: IBlockchain = await getNetworkConfig(networkChainIds.arbitrumSepolia);

        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message: `🎉 ¡Tu certificado ha sido emitido exitosamente! 🎉, podes verlo en: https://testnets.opensea.io/assets/arbitrum-sepolia/${networkConfig.contracts.chatterNFTAddress}/${id}`,
        };
        await sendBotMessage(payload);
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
        
        if(!isValidPhoneNumber(channel_user_id)) return "";

        const networkConfig: IBlockchain = await getNetworkConfig();

        const payload: OperatorReplyPayload = {
            data_token: BOT_DATA_TOKEN!,
            channel_user_id,
            message: `💸 Enviaste ${amount} ${token} a ${to}! 💸 \n Puedes ver la transacción aquí: ${networkConfig.explorer}/tx/${txHash}`,
        };
        const data = await sendBotMessage(payload);
        console.log('Notification sent:', data);
        return data;
    } catch (error) {
        console.error('Error in sendOutgoingTransferNotification:', error);
        throw error;
    }
}
