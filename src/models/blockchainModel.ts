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

/** Who funds the registration deposit, and who funds the network fees around it. */
export type CardanoStakingFinancingMode = 'user_deposit_sponsor_fees' | 'sponsor_deposit_and_fees';

/** Vote delegation a newly registered credential starts with. */
export type CardanoGovernanceDefault = 'always_abstain' | 'always_no_confidence';

/** A pool the network is allowed to delegate to, and whether it is currently offered. */
export interface CardanoAllowlistedPool {
  poolId: string;
  enabled: boolean;
}

/**
 * Staking settings, per network. Absent on a Cardano network that does not stake, which is why the
 * whole subdocument is optional: a network with no `staking` behaves exactly as it did before.
 *
 * Every lovelace amount is a decimal string. `number` loses precision above 2^53 and these are
 * budgets that get compared against on-chain values, so they are read as `bigint` and never as a
 * float.
 */
export interface CardanoStakingSettings {
  /**
   * Whether this network may sign staking operations. Off by default, and the environment flag has
   * to agree: either one being false is enough to refuse. Reads and reconciliation keep working.
   */
  enabled: boolean;
  /** Who funds the registration deposit. Fixed per registration cycle, never rewritten in place. */
  financingMode: CardanoStakingFinancingMode;
  /** Pool every new registration delegates to. Must be present and enabled in `allowlistedPools`. */
  defaultPoolId: string | null;
  /** Pools this network may delegate to. Validated against the pool's own network before signing. */
  allowlistedPools: CardanoAllowlistedPool[];
  /** Vote delegation set on first registration, as accepted in the terms. */
  defaultGovernance: CardanoGovernanceDefault;
  /** Version of the staking terms a user has to have accepted for this network to enrol them. */
  termsVersion: string;
  /**
   * Commercial entry threshold, unrelated to the protocol deposit.
   *
   * It has to clear the deposit **plus** the minimum transfer amount plus room for fees, or a user
   * lands registered and unable to move anything: the deposit leaves their UTxOs, and what is left
   * falls under the token's own transfer minimum. This is a product decision, not a derived value,
   * so it is stored rather than computed — but it is validated against the ADA token's transfer
   * minimum at read time.
   */
  minimumUserAdaForEnrollmentLovelace: string;
  /** Ceiling on wallets touched per scheduler run, so a run finishes inside its deadline. */
  maxWalletsPerRun: number;
  /** Ceiling on provider calls per run, to stay inside the provider's quota. */
  maxProviderRequestsPerRun: number;
  /** Anti-churn: sponsored registrations allowed per account inside the rolling window. */
  maxSponsoredRegistrationsPerAccountRollingWindow: number;
  /** Length of that rolling window, in days. */
  sponsorRollingWindowDays: number;
  /** Budget the sponsor may spend on fees per window. Enforced by an atomic counter, not by a scan. */
  dailySponsorFeeBudgetLovelace: string;
  /** Whether a retiring pool triggers redelegation to another allowlisted pool. */
  autoRedelegateRetiredPools: boolean;
  /** Whether the governance surface is offered at all on this network. */
  governanceEnabled: boolean;
  /**
   * DReps a user may delegate to. **Empty means no restriction**, unlike `allowlistedPools`.
   *
   * Narrowing who can represent a user is ChatterPay choosing their governance, which is a different
   * thing from picking a default pool. The list exists so the decision can be made, not because one
   * was made here.
   */
  allowlistedDReps: string[];
  /**
   * Whether registering ChatterPay's own DRep credential and casting votes is available.
   *
   * Separate from `enabled` on purpose: that flag being off must not be what keeps this off. It
   * needs its own deposit policy, custody model and scope before it can be turned on.
   */
  drepOwnEnabled: boolean;
}

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
  /** Present only where staking is configured. A network without it does not stake. */
  staking?: CardanoStakingSettings;
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

const allowlistedPoolSchema = new Schema<CardanoAllowlistedPool>(
  {
    poolId: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: false }
  },
  { _id: false }
);

// Defaults are the refusing ones. A staking subdocument written without them should not sign, enrol
// or sponsor anything: the values that decide money are the ones an operator has to state.
const cardanoStakingSchema = new Schema<CardanoStakingSettings>(
  {
    enabled: { type: Boolean, required: true, default: false },
    financingMode: {
      type: String,
      enum: ['user_deposit_sponsor_fees', 'sponsor_deposit_and_fees'],
      required: true,
      default: 'user_deposit_sponsor_fees'
    },
    defaultPoolId: { type: String, required: false, default: null },
    allowlistedPools: { type: [allowlistedPoolSchema], required: true, default: () => [] },
    defaultGovernance: {
      type: String,
      enum: ['always_abstain', 'always_no_confidence'],
      required: true,
      default: 'always_abstain'
    },
    termsVersion: { type: String, required: true },
    minimumUserAdaForEnrollmentLovelace: { type: String, required: true },
    maxWalletsPerRun: { type: Number, required: true, default: 500 },
    maxProviderRequestsPerRun: { type: Number, required: true, default: 1000 },
    maxSponsoredRegistrationsPerAccountRollingWindow: { type: Number, required: true, default: 2 },
    sponsorRollingWindowDays: { type: Number, required: true, default: 30 },
    dailySponsorFeeBudgetLovelace: { type: String, required: true, default: '0' },
    autoRedelegateRetiredPools: { type: Boolean, required: true, default: false },
    governanceEnabled: { type: Boolean, required: true, default: false },
    allowlistedDReps: { type: [String], required: true, default: () => [] },
    drepOwnEnabled: { type: Boolean, required: true, default: false }
  },
  { _id: false }
);

const cardanoSettingsSchema = new Schema<CardanoNetworkSettings>(
  {
    network: { type: String, required: true },
    providerUrl: { type: String, required: true },
    ttlSlots: { type: Number, required: true, default: 900 },
    depositConfirmations: { type: Number, required: true, default: 3 },
    staking: { type: cardanoStakingSchema, required: false }
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
