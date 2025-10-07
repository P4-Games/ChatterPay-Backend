import { model, Schema, Document } from 'mongoose';

export interface ITokenWhitelist extends Document {
  token: string;
  chainId: number;
  active: boolean;
  priceFeed?: string;
  stableFlag?: boolean;
  addedAt: Date;
  updatedAt: Date;
}

const tokenWhitelistSchema = new Schema<ITokenWhitelist>({
  token: { type: String, required: true },
  chainId: { type: Number, required: true },
  active: { type: Boolean, required: true, default: true },
  priceFeed: { type: String, required: false },
  stableFlag: { type: Boolean, required: false, default: false },
  addedAt: { type: Date, required: true, default: Date.now },
  updatedAt: { type: Date, required: true, default: Date.now }
});

// Create unique compound index
tokenWhitelistSchema.index({ chainId: 1, token: 1 }, { unique: true, name: 'uniq_chain_token' });

// Additional indexes for queries
tokenWhitelistSchema.index({ active: 1 });
tokenWhitelistSchema.index({ chainId: 1, active: 1 });

// Update the updatedAt field on save
tokenWhitelistSchema.pre('save', function updateTimestamp(next) {
  this.updatedAt = new Date();
  next();
});

export const TokenWhitelistModel = model<ITokenWhitelist>(
  'TokenWhitelist',
  tokenWhitelistSchema,
  'token_whitelist'
);
