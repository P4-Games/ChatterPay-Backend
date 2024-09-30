import axios from 'axios';
import mongoose from 'mongoose';

import { connectToMongoDB } from './dbConnections';
import { getNetworkConfig } from '../services/networkService';
import { UserConversation, userConversationSchema } from '../models/userConversation';

const botDataToken = process.env?.BOT_DATA_TOKEN ?? '';
const botApiUrl = process.env?.BOT_API_URL ?? '';

interface OperatorReplyPayload {
    data_token: string;
    channel_user_id: string;
    message: string;
}

interface NetworkConfig {
    explorer: string;
    chatterNFTAddress: string;
}

/**
 * Connects to MongoDB and returns the UserConversation model.
 */
async function getUserConversationModel(): Promise<mongoose.Model<UserConversation>> {
    const mongoUrl = process.env?.MONGO_URI_CHATTERPAY ?? '';
    const connection = await connectToMongoDB(mongoUrl);
    return connection.model('user_conversations', userConversationSchema);
}

/**
 * Updates the user conversation status in the database.
 */
async function updateUserConversationStatus(
    channelUserId: string,
    newStatus: string,
): Promise<void> {
    try {
        const userConversation = await getUserConversationModel();
        await userConversation.findOneAndUpdate(
            { channel_user_id: channelUserId },
            { $set: { control: newStatus } },
        );
        console.log('Status update successful');
    } catch (error) {
        console.error('Error updating user_conversations', error);
        throw error;
    }
}

/**
 * Sends an operator reply to the API.
 */
async function sendBotMessage(payload: OperatorReplyPayload): Promise<unknown> {
    try {
        const sendMsgEndpint = `${botApiUrl}/chatbot/conversations/send-message`;
        const response = await axios.post(sendMsgEndpint, payload, {
            headers: {
                'Content-Type': 'application/json',
            },
        });
        console.log('API Response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error sending operator reply:', error.messa);
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
): Promise<void> {
    try {
        console.log('Sending transfer notification');
        await updateUserConversationStatus(channel_user_id, 'operator');

        const payload: OperatorReplyPayload = {
            data_token: `${botDataToken}`,
            channel_user_id,
            message: `${from} te envio ${amount} ${token} 💸. \n Ya estan disponibles en tu billetera ChatterPay! 🥳`,
        };
        await sendBotMessage(payload);

        await updateUserConversationStatus(channel_user_id, 'assistant');
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
        const networkConfig: NetworkConfig = await getNetworkConfig();

        const payload: OperatorReplyPayload = {
            data_token: `${botDataToken}`,
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
export async function sendMintNotification(channel_user_id: string, id: number): Promise<void> {
    try {
        console.log('Sending mint notification');
        const networkConfig: NetworkConfig = await getNetworkConfig(421614);

        const payload: OperatorReplyPayload = {
            data_token: `${botDataToken}`,
            channel_user_id,
            message: `🎉 ¡Tu certificado ha sido emitido exitosamente! 🎉, podes verlo en: https://testnets.opensea.io/assets/arbitrum-sepolia/${networkConfig.chatterNFTAddress}/${id}`,
        };
        await sendBotMessage(payload);
    } catch (error) {
        console.error('Error in sendMintNotification:', error.message);
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
): Promise<void> {
    try {
        console.log('Sending outgoing transfer notification');
        await updateUserConversationStatus(channel_user_id, 'operator');

        const networkConfig: NetworkConfig = await getNetworkConfig();

        const payload: OperatorReplyPayload = {
            data_token: `${botDataToken}`,
            channel_user_id,
            message: `💸 Enviaste ${amount} ${token} a ${to}! 💸 \n Puedes ver la transacción aquí: ${networkConfig.explorer}/tx/${txHash}`,
        };
        await sendBotMessage(payload);

        await updateUserConversationStatus(channel_user_id, 'assistant');
    } catch (error) {
        console.error('Error in sendOutgoingTransferNotification:', error);
        throw error;
    }
}
