import mongoose from 'mongoose';

export interface UserConversation {
    name: string;
    channel_user_id: string;
    created_ts: Date;
    last_message_ts: Date;
    cost: number;
    messages: unknown[];
    status: string;
    control: string;
    messaging_channel: string;
    unread_count: number;
}

export const userConversationSchema = new mongoose.Schema<UserConversation>({
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
