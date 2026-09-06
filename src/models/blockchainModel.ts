import { type Document, model, Schema } from 'mongoose';

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

export interface BlockchainLimitDetail {
  [unit: string]: number;
}

export interface BlockchainOperationLimits {
  L1: BlockchainLimitDetail;
  L2: BlockchainLimitDetail;
}

export interface ExternalDeposits {
  lastBlockProcessed: number;
  lastBlockTimestampProcessed: number;
  updatedAt: Date;
}

/**
 * Which execution family a network belongs to.
 *
 * Absent on every document written before Cardano existed, which is why `evm` is the default: a
 * network with no family is an EVM network, and every field below that only makes sense for EVM
 * keeps being required for it.
 */
export type BlockchainFamily = 'evm' | 'cardano';

/** Settings that only a Cardano network has. Absent on every EVM document. */
export interface CardanoNetworkSettings {
  /** `testnet` or `mainnet`. Decides the header byte of every address issued (CIP-19). */
  network: string;
  /** Provider root URL. The API key, when the provider needs one, lives in the environment. */
  providerUrl: string;
  /** Slots of validity given to a transaction, counted from the tip. */
  ttlSlots: number;
  /** Confirmations required before an output is spendable. */
  depositConfirmations: number;
}

export interface IBlockchain extends Document {
  name: string;
  /** Execution family. Defaults to `evm` so existing documents keep their meaning. */
  family: BlockchainFamily;
  manteca_name: string;
  chainId: number;
  rpc: string;
  rpcBundler: string;
  logo: string;
  explorer: string;
  marketplaceOpenseaUrl: string;
  environment: string;
  supportsEIP1559: boolean;
  externalDeposits: ExternalDeposits;
  /** Present only on Cardano networks. */
  cardano?: CardanoNetworkSettings;
  contracts: {
    entryPoint: string;
    factoryAddress: string;
    chatterPayAddress: string;
    chatterNFTAddress: string;
    paymasterAddress?: string;
    routerAddress?: string;
    poolAddress?: string;
    quoterAddress: string;
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
  limits: {
    /** Daily operation count per user level. Required on every family. */
    transfer: BlockchainOperationLimits;
    /**
     * Absent on non-EVM networks, which is why these are optional here and conditionally required
     * in the schema. A Cardano document has no swap and no NFT operations to limit, and typing them
     * as always present would make every reader believe a value that is not there.
     */
    swap?: BlockchainOperationLimits;
    mint_nft?: BlockchainOperationLimits;
    mint_nft_copy?: BlockchainOperationLimits;
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

// See the note in tokenModel: nested limits are value objects, and stamping an ObjectId into each
// one makes seeded documents differ in shape from the ones already stored.
const limitDetailSchema = new Schema<BlockchainLimitDetail>(
  {},
  { typeKey: '$type', strict: false, _id: false }
);

const operationLimitsSchema = new Schema<BlockchainOperationLimits>(
  {
    L1: { type: limitDetailSchema, required: true },
    L2: { type: limitDetailSchema, required: true }
  },
  { _id: false }
);

const externalDepositsSchema = new Schema<ExternalDeposits>(
  {
    lastBlockProcessed: { type: Number, required: true },
    lastBlockTimestampProcessed: { type: Number, required: false },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const cardanoSettingsSchema = new Schema<CardanoNetworkSettings>(
  {
    network: { type: String, required: true },
    providerUrl: { type: String, required: true },
    ttlSlots: { type: Number, required: true, default: 900 },
    depositConfirmations: { type: Number, required: true, default: 3 }
  },
  { _id: false }
);

/**
 * Required for EVM networks, optional for everything else.
 *
 * The alternative — filling a Cardano document with dummy values so it satisfies an EVM-shaped
 * schema — produces a row that *says* it has an RPC endpoint and a paymaster. Something would
 * eventually believe it, far from here.
 */
function evmOnly(this: IBlockchain): boolean {
  return (this?.family ?? 'evm') === 'evm';
}

const blockchainSchema = new Schema<IBlockchain>({
  name: { type: String, required: true },
  family: { type: String, enum: ['evm', 'cardano'], required: true, default: 'evm' },
  manteca_name: { type: String, required: evmOnly },
  chainId: { type: Number, required: true },
  rpc: { type: String, required: evmOnly },
  rpcBundler: { type: String, required: evmOnly },
  logo: { type: String, required: false },
  explorer: { type: String, required: true },
  marketplaceOpenseaUrl: { type: String, required: evmOnly },
  environment: { type: String, required: true },
  supportsEIP1559: { type: Boolean, required: evmOnly },
  externalDeposits: { type: externalDepositsSchema, required: evmOnly },
  cardano: { type: cardanoSettingsSchema, required: false },
  contracts: {
    entryPoint: { type: String, required: false },
    factoryAddress: { type: String, required: false },
    chatterPayAddress: { type: String, required: false },
    chatterNFTAddress: { type: String, required: false },
    paymasterAddress: { type: String, required: false },
    routerAddress: { type: String, required: false },
    poolAddress: { type: String, required: false },
    quoterAddress: { type: String, required: false }
  },
  // Cardano has no gas: the fee comes out of the inputs of the transaction itself, sized by the
  // serialized bytes rather than metered by execution.
  gas: {
    useFixedValues: { type: Boolean, required: evmOnly },
    operations: {
      transfer: { type: opGasSchema, required: evmOnly },
      swap: { type: opGasSchema, required: evmOnly }
    }
  },
  // No paymaster and no backend signer to keep funded: on Cardano the sender pays, always.
  balances: {
    paymasterMinBalance: { type: String, required: evmOnly },
    paymasterTargetBalance: { type: String, required: evmOnly },
    backendSignerMinBalance: { type: String, required: evmOnly },
    userSignerMinBalance: { type: String, required: evmOnly },
    userSignerBalanceToTransfer: { type: String, required: evmOnly }
  },
  limits: {
    // Transfer limits apply to every family — they are product policy, not an EVM detail.
    transfer: { type: operationLimitsSchema, required: true },
    swap: { type: operationLimitsSchema, required: evmOnly },
    mint_nft: { type: operationLimitsSchema, required: evmOnly },
    mint_nft_copy: { type: operationLimitsSchema, required: evmOnly }
  }
});

const Blockchain = model<IBlockchain>('Blockchain', blockchainSchema, 'blockchains');

export default Blockchain;
