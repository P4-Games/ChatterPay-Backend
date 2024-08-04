import axios from 'axios';
import { channel } from 'diagnostics_channel';
import mongoose from 'mongoose';

// Definir el esquema y modelo para user_conversations
const userConversationSchema = new mongoose.Schema({
	name: String,
	channel_user_id: String,
	created_ts: Date,
	last_message_ts: Date,
	cost: Number,
	messages: Array,
	status: String,
	control: String,
	messaging_channel: String,
	unread_count: Number,
});

const UserConversation = mongoose.model('user_conversations', userConversationSchema);

// Función para conectar a MongoDB
const connectToMongoDB = async () => {
	try {
		await mongoose.connect('mongodb+srv://chatbot:p4tech@p4techsolutions.hvxfjoc.mongodb.net/chatterpay');
		console.log('Conexión a MongoDB exitosa');
	} catch (error) {
		console.error('Error al conectar a MongoDB', error);
	}
};

// Función para actualizar user_conversations
const updateUserConversationStatus = async (channelUserId: string, newStatus: string) => {
	try {
		await UserConversation.findOneAndUpdate(
			{ channel_user_id: channelUserId },
			{ $set: { control: newStatus } }
		);
		console.log('Actualización de estado exitosa');
	} catch (error) {
		console.error('Error al actualizar user_conversations', error);
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

export const sendTransferNotification = async (channel_user_id: string, from: string | null, amount: string, token: string) => {
	console.log("im here sending notifications");
	await connectToMongoDB();
	console.log("im connected to mongo")
	await updateUserConversationStatus(channel_user_id, "operator");
	console.log("i updated the conversation to operator")
	const payload: OperatorReplyPayload = {
		data_token: 'ddbe7f0e3d93447486efa9ef77954ae7',
		channel_user_id: channel_user_id, // El id del MongoDB de la conversación
		message: `Haz recibido una transferencia ${from ? `de ${from}` : ""}! Te ${from ? "envió" : "enviaron"} ${amount} ${token}`
	};
	await sendOperatorReply(payload);
	console.log("i sended operator reply")
	await updateUserConversationStatus(channel_user_id, "assistant");
	console.log("i updated the conversation to assistant")
	mongoose.connection.close(); // Cierra la conexión después de la operación
}