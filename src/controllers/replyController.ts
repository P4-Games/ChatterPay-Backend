import axios from 'axios';
import { connectToMongoDB } from '../db/dbConnections';
import mongoose from 'mongoose';
import { userConversationSchema } from '../models/userConversation';

export const sendTransferNotification = async (channel_user_id: string, from: string | null, amount: string, token: string) => {
    const mongoUrl = 'mongodb+srv://chatbot:p4tech@p4techsolutions.hvxfjoc.mongodb.net/chatterpay';
    
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
            message: `${from} te envio ${amount} ${token}. \n Ya estan disponibles en tu billetera ChatterPay! `
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
		const response = await axios.post('https://chatterpay-i7bji6tiqa-uc.a.run.app/chatbot/conversations/operator-reply', payload, {
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