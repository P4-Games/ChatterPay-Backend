import mongoose from 'mongoose';

const LastProcessedBlockSchema = new mongoose.Schema({
  networkName: { type: String, required: true, unique: true },
  blockNumber: { type: Number, required: true },
  updatedAt: { type: Date, default: Date.now }
});

export const LastProcessedBlock = mongoose.model('LastProcessedBlock', LastProcessedBlockSchema);
