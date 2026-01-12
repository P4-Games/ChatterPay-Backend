import { type Document, model, Schema } from 'mongoose';

export interface TokenLimitDetail {
  min: number;
  max: number;
}

export interface TokenOperationLimits {
  L1: TokenLimitDetail;
  L2: TokenLimitDetail;
}

export interface TokenLimitDetail {
  min: number;
  max: number;
}

export interface TokenOperationLimits {
  L1: TokenLimitDetail;
  L2: TokenLimitDetail;
}

export interface IToken extends Document {
  name: string;
  chain_id: number;
  decimals: number;
  logo: string;
  address: string;
  symbol: string;
  type: string;
  ramp_enabled: boolean;
  display_decimals: number;
  display_symbol: string;
  operations_limits: {
    transfer: TokenOperationLimits;
    swap: TokenOperationLimits;
  };
}

const limitDetailSchema = new Schema<TokenLimitDetail>({
  min: { type: Number, required: true },
  max: { type: Number, required: true }
});

const operationLimitsSchema = new Schema<TokenOperationLimits>({
  L1: { type: limitDetailSchema, required: true },
  L2: { type: limitDetailSchema, required: true }
});

const tokenSchema = new Schema<IToken>({
  name: { type: String, required: true },
  chain_id: { type: Number, required: true },
  decimals: { type: Number, required: true },
  address: { type: String, required: true, unique: true },
  logo: { type: String, required: false },
  symbol: { type: String, required: true },
  type: { type: String, required: true },
  ramp_enabled: { type: Boolean, required: true },
  display_decimals: { type: Number, required: true },
  display_symbol: { type: String, required: true },
  operations_limits: {
    transfer: { type: operationLimitsSchema, required: true },
    swap: { type: operationLimitsSchema, required: true }
  }
});

const Token = model<IToken>('Token', tokenSchema, 'tokens');

export default Token;
