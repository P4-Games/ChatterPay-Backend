import axios from 'axios';
import { connectToMongoDB } from '../db/dbConnections';
import mongoose from 'mongoose';
import { userConversationSchema } from '../models/userConversation';
import { SCROLL_CONFIG } from '../constants/networks';

const mongoUrl = 'mongodb+srv://chatbot:p4tech@p4techsolutions.hvxfjoc.mongodb.net/chatterpay';

export const sendTransferNotification = async (channel_user_id: string, from: string | null, amount: string, token: string) => {
    try {
        console.log("Sending notifications");
        const connection = await connectToMongoDB(mongoUrl);
        
        // Creamos los modelos usando esta conexión específica
        const UserConversation = connection.model('user_conversations', userConversationSchema);
        
        await updateUserConversationStatus(UserConversation, channel_user_id, "operator");
        console.log("Updated conversation to operator");
        
        const payload: OperatorReplyPayload = {
            data_token: 'ddbe7f0e3d93447486efa9ef77954ae7',
            channel_user_id: channel_user_id,
            message: `${from} te envio ${amount} ${token} 💸. \n Ya estan disponibles en tu billetera ChatterPay! 🥳`
        };
        await sendOperatorReply(payload);
        console.log("Sent operator reply");

		await updateUserConversationStatus(UserConversation, channel_user_id, "assistant");
        console.log("Updated conversation to assistant");
    } catch (error) {
        console.error("Error in sendTransferNotification:", error);
        throw error;
    }
}

export const sendSwapNotification = async (channel_user_id: string, token: string, amount: string, result: string, outputToken: string, transactionHash: string) => {
    
    try {
        console.log("Sending notifications");
        const connection = await connectToMongoDB(mongoUrl);
        
        // Creamos los modelos usando esta conexión específica
        const UserConversation = connection.model('user_conversations', userConversationSchema);
        
        const payload: OperatorReplyPayload = {
            data_token: 'ddbe7f0e3d93447486efa9ef77954ae7',
            channel_user_id: channel_user_id,
            message: `🔄 Intercambiaste ${amount} ${token} por ${Math.round(parseFloat(result) * 1e2) / 1e2} ${outputToken}! 🔄 \n Puedes ver la transacción aquí: ${SCROLL_CONFIG.EXPLORER_URL}/tx/${transactionHash}`
        };
        await sendOperatorReply(payload);
        console.log("Sent operator reply");

        console.log("Updated conversation to assistant");
    } catch (error) {
        console.error("Error in sendTransferNotification:", error);
        throw error;
    }
}

// Función para enviar notificaciones de minteo de certificados y recuerdos onchain
export const sendMintNotification = async (channel_user_id: string, id: number) => {
    try {
        console.log("Sending notifications");
        const connection = await connectToMongoDB(mongoUrl);
        
        // Creamos los modelos usando esta conexión específica
        const UserConversation = connection.model('user_conversations', userConversationSchema);
        
        const payload: OperatorReplyPayload = {
            data_token: 'ddbe7f0e3d93447486efa9ef77954ae7',
            channel_user_id: channel_user_id,
            message: `🎉 ¡Tu certificado ha sido emitido exitosamente! 🎉, podes verlo en: https://testnets.opensea.io/assets/arbitrum-sepolia/${SCROLL_CONFIG.CHATTER_NFT}/${id}`,
        };

        await sendOperatorReply(payload);
        console.log("Sent operator reply");
    } catch (error) {
        console.error("Error in sendMintNotification:", error);
        throw error;
    }
}

export const sendTransferNotification2 = async (channel_user_id: string, to:string | null, amount: string, token: string, txHash:string) => {
    
    try {
        console.log("Sending notifications");
        const connection = await connectToMongoDB(mongoUrl);
        
        // Creamos los modelos usando esta conexión específica
        const UserConversation = connection.model('user_conversations', userConversationSchema);
        
        await updateUserConversationStatus(UserConversation, channel_user_id, "operator");
        console.log("Updated conversation to operator");
        
        const payload: OperatorReplyPayload = {
            data_token: 'ddbe7f0e3d93447486efa9ef77954ae7',
            channel_user_id: channel_user_id,
            message: `💸 Enviaste ${amount} ${token} a ${to}! 💸 \n Puedes ver la transacción aquí: https://sepolia.scrollscan.com/tx/${txHash}`
        };
        await sendOperatorReply(payload);
        console.log("Sent operator reply");

		await updateUserConversationStatus(UserConversation, channel_user_id, "assistant");
        console.log("Updated conversation to assistant");
    } catch (error) {
        console.error("Error in sendTransferNotification:", error);
        throw error;
    }
}

const updateUserConversationStatus = async (UserConversation: mongoose.Model<any>, channelUserId: string, newStatus: string) => {
    try {
        await UserConversation.findOneAndUpdate(
            { channel_user_id: channelUserId },
            { $set: { control: newStatus } }
        );
        console.log('Actualización de estado exitosa');
    } catch (error) {
        console.error('Error al actualizar user_conversations', error);
        throw error;
    }
};

interface OperatorReplyPayload {
	data_token: string;
	channel_user_id: string;
	message: string;
}

const sendOperatorReply = async (payload: OperatorReplyPayload) => {
	try {
		const response = await axios.post('https://chatterpay-i7bji6tiqa-uc.a.run.app/chatbot/conversations/send-message', payload, {
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${payload.data_token}`
			}
		});
		console.log('Respuesta de la API:', response.data);
		return response.data;
	} catch (error) {
		console.error('Error al enviar la respuesta del operador:', error);
		throw error;
	}
};