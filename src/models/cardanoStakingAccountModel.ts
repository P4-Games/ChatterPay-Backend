import { type Document, model, Schema, type Types } from 'mongoose';

/**
 * Where a wallet stands with respect to staking.
 *
 * This is the *operational* state, shown to the user and used to decide what to offer. What the
 * chain is doing with a given transaction lives in `cardano_staking_operations.chainOutcome`, and
 * the two are deliberately separate: `manual_review` says an operator is looking at something, not
 * that the chain has settled.
 */
export type CardanoStakingAccountState =
  | 'awaiting_consent'
  | 'awaiting_funds'
  | 'activation_pending'
  | 'signing'
  | 'submitted'
  | 'active'
  | 'exit_pending'
  | 'exit_submitted'
  | 'reconcile_required'
  | 'manual_review';

/**
 * Which credential a DRep identifier denotes.
 *
 * Kept alongside the hash because two DReps can share a hash and differ in type, so a hash alone
 * does not identify one.
 */
export type CardanoDRepCredentialType = 'key_hash' | 'script_hash';

/** A DRep credential: the hash and what the hash is a digest of. */
export interface CardanoDRepCredential {
  type: CardanoDRepCredentialType;
  /** blake2b-224 digest, 28 bytes, lowercase hex without `0x`. */
  hashHex: string;
}

/**
 * Where a credential's voting power goes.
 *
 * `none` means registered and **verified** not to have delegated — a real state that, in Conway,
 * blocks reward withdrawal. It is never the result of a field being absent or a provider failing:
 * those are read errors and do not reach this type.
 */
export type CardanoGovernanceDelegationKind =
  | 'drep'
  | 'always_abstain'
  | 'always_no_confidence'
  | 'none'
  | 'not_registered';

/** Vote delegation as last observed on chain. */
export interface CardanoGovernanceDelegation {
  kind: CardanoGovernanceDelegationKind;
  /** Only on `kind: 'drep'`. */
  credential?: CardanoDRepCredential;
  /** Canonical CIP-129 form. The only form identity is compared by. */
  idCip129?: string;
  /** CIP-105 form when the provider gave one. For display; never compared. */
  idLegacy?: string | null;
  /** Whether the DRep itself is still active, when the provider reports it. */
  drepStatus?: 'active' | 'retired' | 'unknown';
}

/**
 * Who registered the stake credential.
 *
 * A wallet can arrive already registered and already delegating — the user staked it elsewhere
 * before ChatterPay ever looked, and on Cardano the credential belongs to the key, not to whoever
 * happens to be reading it. Recording that is what keeps this service from doing two wrong things:
 * registering a credential that is already registered, which the ledger refuses and which costs a
 * sponsor fee to discover, and writing a deposit event as though ChatterPay had paid a deposit it
 * never paid.
 *
 * `unknown` is a real state, not a placeholder for `external`. Before a confirmed on-chain read
 * there is nothing to conclude, and concluding `external` early would attribute a user's deposit to
 * nobody in particular while concluding `chatterpay` would claim one that was never made.
 */
export type CardanoStakingRegistrationOrigin = 'unknown' | 'chatterpay' | 'external';

/**
 * On-chain facts, as last read.
 *
 * Everything here is a snapshot with an `asOf`, not a ledger this service maintains. A stale or
 * failed read leaves the previous values in place and is surfaced through staleness, never by
 * writing zeroes.
 */
export interface CardanoStakingOnChain {
  /** Whether the stake credential is registered. */
  registered: boolean;
  poolId: string | null;
  governanceDelegation: CardanoGovernanceDelegation | null;
  /**
   * Deposit **actually paid** at registration, in lovelace.
   *
   * Read from the confirmed transaction, not from the current protocol parameter. Cardano refunds
   * what was deposited, so a parameter that changed between registration and exit would make an
   * unregistration built from the current value fail to balance.
   *
   * `null` on a credential registered outside ChatterPay whose provider does not report the figure.
   * That is a refusal to guess and it blocks an exit rather than producing one that cannot balance.
   */
  depositLovelace: string | null;
  /** Who paid that deposit. See {@link CardanoStakingRegistrationOrigin}. */
  registrationOrigin: CardanoStakingRegistrationOrigin;
  /** Rewards sitting in the reward account, withdrawable now. Counts towards net worth. */
  withdrawableRewardsLovelace: string;
  /** Calculated but not yet distributed. Not withdrawable, and never counted as net worth. */
  pendingRewardsLovelace: string;
  /** Sum of every credit ever observed. Already spent ones included, so it never sums into a balance. */
  lifetimeRewardsLovelace: string;
  /** Whether the reward history could be rebuilt in full. */
  historicalCompleteness: 'complete' | 'partial';
  /** When these values were read. */
  asOf: Date | null;
}

/** Evidence that the user accepted the staking terms. */
export interface CardanoStakingTermsConsent {
  version: string;
  acceptedAt: Date;
  source: string;
}

/** The user's opt-in, versioned for compare-and-swap. */
export interface CardanoStakingPreference {
  enabled: boolean;
  version: number;
  updatedAt: Date;
}

export interface ICardanoStakingAccount extends Document {
  userId: Types.ObjectId;
  chainId: number;
  /** Base address, as stored in `users.wallets[]`. Never re-derived here. */
  walletAddress: string;
  /** CIP-19 type 14 reward address for the same stake credential. */
  rewardAddress: string;
  /** Stake credential hash, lowercase hex without `0x`. Unique per network. */
  stakeCredentialHex: string;
  termsConsent: CardanoStakingTermsConsent | null;
  preference: CardanoStakingPreference;
  state: CardanoStakingAccountState;
  onChain: CardanoStakingOnChain;
  /** Always `user` under Plan B. The deposit is the user's asset, not a debt to ChatterPay. */
  depositEconomicOwner: 'user' | 'sponsor';
  /**
   * Fixed when a registration cycle starts, and never rewritten while it lasts.
   *
   * Reading it from configuration at exit time would let a settings change reassign ownership of a
   * deposit that is already on chain.
   */
  financingMode: string | null;
  /** Groups every operation and deposit event of one registration cycle. */
  currentLifecycleId: string | null;
  lastPositiveBalanceAt: Date | null;
  lastObservedAt: Date | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  /** Why auto-enrolment is paused, when it is: budget, churn limit, or an operator. */
  autoEnrollSuspendedReason: string | null;
}

const drepCredentialSchema = new Schema<CardanoDRepCredential>(
  {
    type: { type: String, enum: ['key_hash', 'script_hash'], required: true },
    hashHex: { type: String, required: true }
  },
  { _id: false }
);

const governanceDelegationSchema = new Schema<CardanoGovernanceDelegation>(
  {
    kind: {
      type: String,
      enum: ['drep', 'always_abstain', 'always_no_confidence', 'none', 'not_registered'],
      required: true
    },
    credential: { type: drepCredentialSchema, required: false },
    idCip129: { type: String, required: false },
    idLegacy: { type: String, required: false, default: null },
    drepStatus: { type: String, enum: ['active', 'retired', 'unknown'], required: false }
  },
  { _id: false }
);

// Reward buckets default to '0' rather than being absent: a missing amount reads as unknown, and
// every consumer would have to decide what to do with it. Zero rewards is the honest starting state.
const onChainSchema = new Schema<CardanoStakingOnChain>(
  {
    registered: { type: Boolean, required: true, default: false },
    poolId: { type: String, required: false, default: null },
    governanceDelegation: { type: governanceDelegationSchema, required: false, default: null },
    depositLovelace: { type: String, required: false, default: null },
    registrationOrigin: {
      type: String,
      enum: ['unknown', 'chatterpay', 'external'],
      required: true,
      default: 'unknown'
    },
    withdrawableRewardsLovelace: { type: String, required: true, default: '0' },
    pendingRewardsLovelace: { type: String, required: true, default: '0' },
    lifetimeRewardsLovelace: { type: String, required: true, default: '0' },
    historicalCompleteness: {
      type: String,
      enum: ['complete', 'partial'],
      required: true,
      default: 'partial'
    },
    asOf: { type: Date, required: false, default: null }
  },
  { _id: false }
);

const termsConsentSchema = new Schema<CardanoStakingTermsConsent>(
  {
    version: { type: String, required: true },
    acceptedAt: { type: Date, required: true },
    source: { type: String, required: true }
  },
  { _id: false }
);

const preferenceSchema = new Schema<CardanoStakingPreference>(
  {
    enabled: { type: Boolean, required: true, default: false },
    version: { type: Number, required: true, default: 0 },
    updatedAt: { type: Date, required: true, default: Date.now }
  },
  { _id: false }
);

const cardanoStakingAccountSchema = new Schema<ICardanoStakingAccount>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    chainId: { type: Number, required: true },
    walletAddress: { type: String, required: true },
    rewardAddress: { type: String, required: true },
    stakeCredentialHex: { type: String, required: true },
    termsConsent: { type: termsConsentSchema, required: false, default: null },
    preference: { type: preferenceSchema, required: true, default: () => ({}) },
    state: {
      type: String,
      enum: [
        'awaiting_consent',
        'awaiting_funds',
        'activation_pending',
        'signing',
        'submitted',
        'active',
        'exit_pending',
        'exit_submitted',
        'reconcile_required',
        'manual_review'
      ],
      required: true,
      default: 'awaiting_consent'
    },
    onChain: { type: onChainSchema, required: true, default: () => ({}) },
    depositEconomicOwner: {
      type: String,
      enum: ['user', 'sponsor'],
      required: true,
      default: 'user'
    },
    financingMode: { type: String, required: false, default: null },
    currentLifecycleId: { type: String, required: false, default: null },
    lastPositiveBalanceAt: { type: Date, required: false, default: null },
    lastObservedAt: { type: Date, required: false, default: null },
    lastSyncAt: { type: Date, required: false, default: null },
    lastError: { type: String, required: false, default: null },
    autoEnrollSuspendedReason: { type: String, required: false, default: null }
  },
  // The migration owns this collection's existence, not whichever process touches the model
  // first. Mongoose otherwise creates the collection and builds its indexes in the background
  // when the model is compiled, which is at import time: a read-only process would bring the
  // collection into being, and a dry run would leave exactly the trace it promises not to.
  { autoCreate: false, autoIndex: false, timestamps: true }
);

// One account per wallet per network.
cardanoStakingAccountSchema.index(
  { userId: 1, chainId: 1 },
  { unique: true, name: 'user_chain_unique' }
);
// One account per stake credential per network. Two accounts sharing a credential would both claim
// the same deposit and both try to register it.
cardanoStakingAccountSchema.index(
  { chainId: 1, stakeCredentialHex: 1 },
  { unique: true, name: 'chain_credential_unique' }
);
// The daily sweep scans by state and staleness, and pages by _id from a durable cursor.
cardanoStakingAccountSchema.index({ chainId: 1, state: 1, lastSyncAt: 1 }, { name: 'sync_scan' });
cardanoStakingAccountSchema.index({ chainId: 1, _id: 1 }, { name: 'cursor_scan' });

const CardanoStakingAccount = model<ICardanoStakingAccount>(
  'CardanoStakingAccount',
  cardanoStakingAccountSchema,
  'cardano_staking_accounts'
);

export default CardanoStakingAccount;
