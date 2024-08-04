import mongoose, { connection } from "mongoose";

export const userConversationSchema = new mongoose.Schema({
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

interface IUserConversation extends mongoose.Document {
    name: string;
    channel_user_id: string;
    created_ts: Date;
    last_message_ts: Date;
    cost: number;
    messages: any[];
    status: string;
    control: string;
    messaging_channel: string;
    unread_count: number;
}

// Luego, usa esta interfaz al crear el modelo:
const UserConversation = connection.model<IUserConversation>('user_conversations', userConversationSchema);