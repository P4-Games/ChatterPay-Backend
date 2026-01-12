import { type Document, model, Schema } from 'mongoose';

export interface IExternalDeposit extends Document {
  chainId: number;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  token: string | null; // null for ETH deposits
  value: string; // Raw value as string to preserve precision
  decimals: number;
  blockNumber: number;
  observedAt: Date;
  confirmedAt?: Date;
  provider: 'alchemy' | 'thegraph';
  status: 'observed' | 'finalized' | 'processed';
}

const externalDepositSchema = new Schema<IExternalDeposit>({
  chainId: { type: Number, required: true },
  txHash: { type: String, required: true },
  logIndex: { type: Number, required: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  token: { type: String, required: false, default: null }, // null for ETH
  value: { type: String, required: true },
  decimals: { type: Number, required: true, default: 18 },
  blockNumber: { type: Number, required: true },
  observedAt: { type: Date, required: true, default: Date.now },
  confirmedAt: { type: Date, required: false },
  provider: {
    type: String,
    required: true,
    enum: ['alchemy', 'thegraph'],
    default: 'alchemy'
  },
  status: {
    type: String,
    enum: ['observed', 'finalized', 'processed'],
    required: true,
    index: true // keep this, remove duplicate below
  }
});

// Create unique compound index for idempotency
externalDepositSchema.index(
  { chainId: 1, txHash: 1, logIndex: 1 },
  { unique: true, name: 'uniq_chain_tx_log' }
);

// Additional indexes for common queries
externalDepositSchema.index({ to: 1, chainId: 1 });
externalDepositSchema.index({ observedAt: -1 });

export const ExternalDepositModel = model<IExternalDeposit>(
  'ExternalDeposit',
  externalDepositSchema,
  'external_deposits'
);
