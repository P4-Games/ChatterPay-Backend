import mongoose from "mongoose";

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