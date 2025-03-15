import { model, Schema, Document } from 'mongoose';

export interface OpGasValues {
  perGasInitialMultiplier: number;
  perGasIncrement: number;
  callDataInitialMultiplier: number;
  maxRetries: number;
  timeoutMsBetweenRetries: number;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  verificationGasLimit: number;
  callGasLimit: number;
  preVerificationGas: number;
}

export interface IBlockchain extends Document {
  name: string;
  chainId: number;
  rpc: string;
  bundlerUrl?: string;
  logo: string;
  explorer: string;
  marketplaceOpenseaUrl: string;
  environment: string;
  contracts: {
    entryPoint: string;
    factoryAddress: string;
    chatterPayAddress: string;
    chatterNFTAddress: string;
    paymasterAddress?: string;
    routerAddress?: string;
  };
  gas: {
    useFixedValues: boolean;
    operations: {
      transfer: OpGasValues;
      swap: OpGasValues;
    };
  };
  balances: {
    paymasterMinBalance: string;
    paymasterTargetBalance: string;
    backendSignerMinBalance: string;
    userSignerMinBalance: string;
    userSignerBalanceToTransfer: string;
  };
}

const opGasSchema = new Schema<OpGasValues>({
  perGasInitialMultiplier: { type: Number, required: true, default: 1.5 },
  perGasIncrement: { type: Number, required: true, default: 1.1 },
  callDataInitialMultiplier: { type: Number, required: true, default: 1.2 },
  maxRetries: { type: Number, required: true, default: 5 },
  timeoutMsBetweenRetries: { type: Number, required: true, default: 5000 },
  maxFeePerGas: { type: String, required: true, default: '0.5' },
  maxPriorityFeePerGas: { type: String, required: true, default: '0.05' },
  verificationGasLimit: { type: Number, required: true, default: 80000 },
  callGasLimit: { type: Number, required: true, default: 149456 },
  preVerificationGas: { type: Number, required: true, default: 80000 }
});

const blockchainSchema = new Schema<IBlockchain>({
  name: { type: String, required: true },
  chainId: { type: Number, required: true },
  rpc: { type: String, required: true },
  bundlerUrl: { type: String, required: false },
  logo: { type: String, required: true },
  explorer: { type: String, required: true },
  marketplaceOpenseaUrl: { type: String, required: true },
  environment: { type: String, required: true },
  contracts: {
    entryPoint: { type: String, required: false },
    factoryAddress: { type: String, required: false },
    chatterPayAddress: { type: String, required: false },
    chatterNFTAddress: { type: String, required: false },
    paymasterAddress: { type: String, required: false },
    routerAddress: { type: String, required: false }
  },
  gas: {
    useFixedValues: { type: Boolean, required: true },
    operations: {
      transfer: { type: opGasSchema, required: true },
      swap: { type: opGasSchema, required: true }
    }
  },
  balances: {
    paymasterMinBalance: { type: String, required: true },
    paymasterTargetBalance: { type: String, required: true },
    backendSignerMinBalance: { type: String, required: true },
    userSignerMinBalance: { type: String, required: true },
    userSignerBalanceToTransfer: { type: String, required: true }
  }
});

const Blockchain = model<IBlockchain>('Blockchain', blockchainSchema, 'blockchains');

export default Blockchain;
