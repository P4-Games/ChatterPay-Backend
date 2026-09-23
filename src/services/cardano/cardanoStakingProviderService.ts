/**
 * Reading stake accounts, rewards, pools and DReps — through either provider, in one vocabulary.
 *
 * The transfer flow needs six things from a provider and gets them from `CardanoProvider`. Staking
 * needs a different set, and they are kept in a separate interface rather than bolted onto that one
 * on purpose: a deployment can move ada without ever reading a stake account, and widening the
 * transfer contract would make every existing implementation — the in-memory ones the transfer
 * tests drive — owe methods they have no reason to have.
 *
 * What the two providers disagree about is not just paths and field names. They disagree about what
 * they *say*, and four of those disagreements are the reason this module is more than a rename.
 *
 * **Registration.** Koios reports a status string; Blockfrost reports two booleans. Neither is a
 * lie, but "not registered" and "the field is missing" are different facts and only one of them is
 * a state. A missing field here is a provider whose contract changed, and it is refused rather than
 * read as an unregistered credential — which looks exactly like a wallet entitled to register again
 * and pay a second deposit.
 *
 * **Vote delegation.** Conway lets a credential delegate to a DRep, to one of two predefined
 * options, or to nothing at all, and the last of those blocks reward withdrawal. Providers spell
 * the predefined options as magic strings. An adapter that folded an unrecognised spelling into
 * `none` would report a credential as undelegated when it is delegated to something this code has
 * not been taught, so an unreadable value raises instead. That is the whole point of
 * `CardanoGovernanceDelegationKind` having both `none` and `not_registered`: they are facts, and a
 * read that failed is neither of them.
 *
 * **Reward identity.** Neither provider gives a reward credit a primary key. One is derived here,
 * from the fields that actually identify a credit — what kind it is, which pool paid it, and which
 * epoch it became spendable — and never from the amount, because the same amount recurs and a key
 * built on it would silently merge two epochs into one.
 *
 * **Pool retirement.** This one is a genuine limitation rather than a difference in spelling, and
 * it is why {@link CardanoPoolState} reports a boolean rather than a three-way status. See the note
 * on that type.
 *
 * Every normaliser in this file is a pure function over a provider's row shape, which is what lets
 * the disagreements above be tested without a network, a key or a funded wallet. The row shapes
 * themselves are not guesses: the Blockfrost ones were read off the configured Preprod root, and
 * the fixtures in the tests are those responses.
 */

import type {
  CardanoDRepCredential,
  CardanoGovernanceDelegation
} from '../../models/cardanoStakingAccountModel';
import type { CardanoProtocolParameters, CardanoProviderKind } from '../../types/cardanoType';
import { parseDRepId } from './cardanoDRepIdService';
import { CardanoProviderError, HttpCardanoProvider } from './cardanoProviderService';

/**
 * Protocol parameters a staking transaction needs, on top of the four a transfer needs.
 *
 * Read for every build rather than cached: the registration deposit is a governable parameter, and
 * a certificate carrying a stale one does not balance and is refused by the ledger outright.
 */
export interface CardanoStakingProtocolParameters extends CardanoProtocolParameters {
  /** What registering a stake credential costs, refundable in full on deregistration. */
  stakeAddressDeposit: bigint;
  /** What registering as a DRep costs. Read for completeness; no path here registers one. */
  drepDeposit: bigint;
}

/** A stake account as the chain currently has it. */
export interface CardanoStakeAccountState {
  registered: boolean;
  /** Bech32 `pool1…`, or `null` when the credential delegates to no pool. */
  poolId: string | null;
  /** Never `null`: an unreadable delegation raises rather than returning one. */
  governanceDelegation: CardanoGovernanceDelegation;
  /** Sitting in the reward account and withdrawable now. */
  withdrawableRewardsLovelace: bigint;
  /** Everything ever credited, when the provider reports a lifetime figure. */
  lifetimeRewardsLovelace: bigint | null;
  /** Everything ever withdrawn, when the provider reports it. */
  withdrawnLovelace: bigint | null;
  /**
   * Deposit the ledger currently holds for this credential, when the provider reports it.
   *
   * This is the figure a deregistration must refund, and it is not necessarily today's
   * `stakeAddressDeposit`: Cardano returns what was paid, and the parameter can have changed since.
   * Blockfrost does not report it at all, which is why the confirmed registration is recorded.
   */
  depositLovelace: bigint | null;
}

/** One reward credit, as an epoch paid it. */
export interface CardanoRewardCredit {
  /** The epoch the reward became spendable. */
  epoch: number;
  amountLovelace: bigint;
  /** How the provider classifies it: member, leader, refund, and so on. */
  sourceType: string | null;
  /** Stable identity of the credit, derived from what identifies it — never from the amount. */
  sourceKey: string;
}

/**
 * A registration or deregistration, as the chain recorded it.
 *
 * The `deposit` is what makes this worth reading. A deregistration must refund exactly what was
 * paid, which is not necessarily today's `stakeAddressDeposit` — the parameter is governable and can
 * have moved since. For a credential this backend registered itself the figure is on the confirmed
 * operation; for one that was already registered when the wallet arrived, this is the only place it
 * exists, and without it an exit cannot be built at all rather than being built wrong.
 */
export interface CardanoRegistrationRecord {
  action: 'registered' | 'deregistered';
  txHash: string;
  /** Lovelace locked by this registration, when the provider reports it. */
  depositLovelace: bigint | null;
  /** Absolute slot of the transaction, so the records can be ordered. */
  slot: number | null;
}

/** A page of reward history, and whether it is the whole of it. */
export interface CardanoRewardHistory {
  credits: readonly CardanoRewardCredit[];
  /**
   * `partial` when paging stopped at the ceiling rather than at the end.
   *
   * Surfaced rather than hidden because lifetime earnings computed from a truncated history are
   * wrong in a direction that looks plausible, and nothing downstream could tell.
   */
  completeness: 'complete' | 'partial';
}

/**
 * Where a stake pool stands, in the one term the product acts on.
 *
 * There is no `retiring` / `retired` distinction here, and that is deliberate rather than lazy.
 * Blockfrost reports a pool's retirement as the list of retirement certificates it has seen, which
 * is identical for a pool retiring three epochs from now and one that retired a year ago — the
 * certificate list and the update log both say `deregistered` in either case, and the epoch the
 * certificate names is not on that endpoint at all.
 *
 * Inventing the distinction would mean claiming precision this adapter does not have. Not making it
 * costs nothing, because the decision it feeds is the same either way: a delegator of a pool with a
 * retirement on record has to be moved. Koios does report the epoch, and fills `retiringEpoch` when
 * it does; Blockfrost leaves it `null` and the flag still answers the question.
 */
export interface CardanoPoolState {
  poolId: string;
  /** Whether a retirement certificate is on record, scheduled or already in effect. */
  retirementScheduled: boolean;
  /** The epoch retirement takes effect, when the provider reports one. */
  retiringEpoch: number | null;
  /** Stake actively delegated to the pool, when reported. Zero on a pool that has stopped. */
  activeStakeLovelace: bigint | null;
}

/**
 * Whether a DRep can still be delegated to usefully.
 *
 * `expired` is a third state and not a shade of the other two: a DRep that has not voted within the
 * activity window keeps its registration and keeps its delegators, but its voting power stops
 * counting. Offering one as a delegation target would hand a user's voice to something that cannot
 * use it, and folding it into `active` is what would do that.
 */
export type CardanoDRepStatus = 'active' | 'expired' | 'retired';

/** A DRep, as the chain has it. */
export interface CardanoDRepState {
  /** Canonical identity. */
  idCip129: string;
  /** The same DRep in the legacy spelling, for display beside it. */
  idCip105: string;
  credential: CardanoDRepCredential;
  status: CardanoDRepStatus;
  /** Stake delegated to this DRep, when the provider reports it. */
  votingPowerLovelace: bigint | null;
}

/** What the staking flow needs from a provider, and nothing more. */
export interface CardanoStakingProvider {
  currentEpoch(): Promise<number>;
  stakingProtocolParameters(): Promise<CardanoStakingProtocolParameters>;
  stakeAccount(rewardAddress: string): Promise<CardanoStakeAccountState>;
  rewardHistory(rewardAddress: string): Promise<CardanoRewardHistory>;
  registrationHistory(rewardAddress: string): Promise<readonly CardanoRegistrationRecord[]>;
  poolState(poolId: string): Promise<CardanoPoolState | null>;
  drepState(id: string): Promise<CardanoDRepState | null>;
  listDReps(limit: number): Promise<readonly CardanoDRepState[]>;
}

/**
 * Ceiling on reward-history paging.
 *
 * Rewards accrue once per epoch, so a credential delegated since Shelley has a few hundred credits
 * at most and this is years of headroom. It exists to bound a provider that pages forever, not to
 * truncate a real history — and when it does bite, the result says `partial` rather than pretending.
 */
const MAX_REWARD_PAGES = 20;

/** Rows per reward page. Both providers accept this size. */
const REWARD_PAGE_SIZE = 100;

/**
 * The spellings providers use for the two predefined vote-delegation targets.
 *
 * Matched case-insensitively and with separators stripped, because the two providers do not agree
 * on punctuation and neither of them promises to keep it. What is deliberately *not* done is a
 * fuzzy match: anything outside this table is unreadable, not a guess.
 */
const PREDEFINED_DELEGATIONS: Readonly<Record<string, 'always_abstain' | 'always_no_confidence'>> =
  {
    drepalwaysabstain: 'always_abstain',
    alwaysabstain: 'always_abstain',
    abstain: 'always_abstain',
    drepalwaysnoconfidence: 'always_no_confidence',
    alwaysnoconfidence: 'always_no_confidence',
    noconfidence: 'always_no_confidence'
  };

/**
 * Reads a vote-delegation field into the domain's terms.
 *
 * The three outcomes this has to keep apart are the reason it exists. A registered credential that
 * delegates to nobody is `none`, and in Conway that is what blocks a reward withdrawal — a state
 * the product has to show and act on. An unregistered credential is `not_registered`, a different
 * thing, reachable without any delegation ever having happened. And a value this adapter cannot
 * classify is neither: it is a read that failed, and it raises.
 *
 * @param raw - Whatever the provider put in its delegation field.
 * @param registered - Whether the credential is registered at all.
 * @returns The delegation, always a value and never `null`.
 * @throws CardanoProviderError `unexpected_response` when the field holds something unrecognised.
 *   Folding it into `none` would report a credential as undelegated while it votes.
 */
export function normalizeGovernanceDelegation(
  raw: unknown,
  registered: boolean
): CardanoGovernanceDelegation {
  if (!registered) return { kind: 'not_registered' };
  if (raw === null || raw === undefined || raw === '') return { kind: 'none' };
  if (typeof raw !== 'string') {
    throw new CardanoProviderError(
      'unexpected_response',
      `CARDANO_PROVIDER_GOVERNANCE_UNREADABLE: ${typeof raw}`
    );
  }

  const predefined = PREDEFINED_DELEGATIONS[raw.toLowerCase().replace(/[^a-z]/g, '')];
  if (predefined !== undefined) return { kind: predefined };

  const parsed = parseDRepId(raw);
  if (parsed === null) {
    throw new CardanoProviderError(
      'unexpected_response',
      `CARDANO_PROVIDER_GOVERNANCE_UNREADABLE: ${raw.slice(0, 80)}`
    );
  }

  return {
    kind: 'drep',
    credential: parsed.credential,
    idCip129: parsed.idCip129,
    idLegacy: parsed.idCip105
  };
}

/**
 * Reads a lovelace amount a provider reported as a string or a number.
 *
 * @param raw - The reported value.
 * @param field - Field name, for the failure message.
 * @returns The amount.
 * @throws CardanoProviderError `unexpected_response` when it is absent or not a whole number. A
 *   missing amount is not zero: reading it as zero would present a reward account as empty and let
 *   a withdrawal be built for nothing.
 */
export function requiredLovelace(raw: unknown, field: string): bigint {
  const amount = optionalLovelace(raw, field);
  if (amount === null) {
    throw new CardanoProviderError(
      'unexpected_response',
      `CARDANO_PROVIDER_AMOUNT_MISSING: ${field}`
    );
  }
  return amount;
}

/**
 * The same read, for a field the provider is allowed not to report.
 *
 * @param raw - The reported value.
 * @param field - Field name, for the failure message.
 * @returns The amount, or `null` when the field is absent.
 * @throws CardanoProviderError `unexpected_response` when the field is present and unreadable —
 *   which is a different fact from absent, and must not be flattened into it.
 */
export function optionalLovelace(raw: unknown, field: string): bigint | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new CardanoProviderError(
        'unexpected_response',
        `CARDANO_PROVIDER_AMOUNT_UNREADABLE: ${field}`
      );
    }
    return BigInt(raw);
  }
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    throw new CardanoProviderError(
      'unexpected_response',
      `CARDANO_PROVIDER_AMOUNT_UNREADABLE: ${field}`
    );
  }
  return BigInt(raw);
}

/**
 * Identity of a reward credit, built from what identifies it.
 *
 * Deliberately not the amount. A credential earns similar amounts epoch after epoch, and a key
 * carrying one would make two epochs collide into a single stored credit — which reads as lifetime
 * earnings that stopped growing rather than as an error.
 *
 * @param sourceType - How the provider classifies the credit.
 * @param poolId - The pool that paid it, when there is one.
 * @param epoch - The epoch it became spendable.
 * @returns A key stable across re-reads of the same credit.
 */
export function rewardSourceKey(
  sourceType: string | null,
  poolId: string | null,
  epoch: number
): string {
  return `${sourceType ?? 'unknown'}:${poolId ?? ''}:${epoch}`;
}

/**
 * Reads a whole-number field.
 *
 * @param raw - The reported value.
 * @param field - Field name, for the failure message.
 * @returns The number.
 * @throws CardanoProviderError `unexpected_response` when it is absent or not a whole number.
 */
export function requiredInteger(raw: unknown, field: string): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CardanoProviderError(
      'unexpected_response',
      `CARDANO_PROVIDER_INTEGER_UNREADABLE: ${field}`
    );
  }
  return value;
}

/**
 * Reads whichever of two registration flags a provider offers.
 *
 * Blockfrost reports both `registered` and `active` on a stake account, and the one that answers
 * the question this backend asks is `registered`: a deposit is held from registration until
 * deregistration, whether or not the credential currently delegates anywhere. `active` is the
 * fallback for a response that predates the other field.
 *
 * @param registered - The `registered` flag, when present.
 * @param active - The `active` flag.
 * @returns Whether a deposit is held for this credential.
 * @throws CardanoProviderError `unexpected_response` when neither is a boolean. Reading a missing
 *   flag as `false` invites a second registration, and a second deposit, for a credential that is
 *   already registered.
 */
export function readRegistrationFlags(registered: unknown, active: unknown): boolean {
  if (typeof registered === 'boolean') return registered;
  if (typeof active === 'boolean') return active;
  throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_ACCOUNT_SHAPE');
}

/**
 * Reads the three flags a DRep carries into one status.
 *
 * Order matters: a retired DRep may also read as expired, and retirement is the stronger fact.
 *
 * @param retired - Whether the registration was withdrawn.
 * @param expired - Whether the activity window lapsed.
 * @returns The status.
 */
export function readDRepStatus(retired: unknown, expired: unknown): CardanoDRepStatus {
  if (retired === true) return 'retired';
  if (expired === true) return 'expired';
  return 'active';
}

/**
 * Builds a DRep state from its canonical identifier.
 *
 * The identifier is the input rather than the raw hash because that is the field both providers
 * agree on the meaning of. Blockfrost's `hex` on a DRep is the **CIP-129 payload** — the header
 * byte and the hash, 29 bytes — not the bare 28-byte credential the name suggests, and a reader
 * that took it for the credential would produce an identity off by one byte on every DRep.
 *
 * @param id - The DRep identifier, in any spelling this backend reads.
 * @param status - Its status.
 * @param votingPower - Delegated stake, when reported.
 * @returns The DRep, identified canonically.
 * @throws CardanoProviderError `unexpected_response` when the identifier cannot be read.
 */
function drepFrom(
  id: unknown,
  status: CardanoDRepStatus,
  votingPower: bigint | null
): CardanoDRepState {
  const parsed = typeof id === 'string' ? parseDRepId(id) : null;
  if (parsed === null) {
    throw new CardanoProviderError(
      'unexpected_response',
      `CARDANO_PROVIDER_DREP_UNREADABLE: ${String(id).slice(0, 80)}`
    );
  }
  return {
    idCip129: parsed.idCip129,
    idCip105: parsed.idCip105,
    credential: parsed.credential,
    status,
    votingPowerLovelace: votingPower
  };
}

/**
 * Whether a listed DRep row is one of the two predefined options rather than a real DRep.
 *
 * Both providers put `drep_always_abstain` and `drep_always_no_confidence` in the DRep list, with
 * the total stake delegated to each. They are delegation targets, but they are not credentials —
 * the domain carries them as their own `kind` — so they are filtered out here rather than pushed
 * through an identifier parser that would correctly refuse them.
 *
 * @param id - The row's identifier.
 * @returns `true` when the row names a predefined option.
 */
function isPredefinedTarget(id: unknown): boolean {
  if (typeof id !== 'string') return false;
  return PREDEFINED_DELEGATIONS[id.toLowerCase().replace(/[^a-z]/g, '')] !== undefined;
}

interface KoiosTipRow {
  epoch_no: number;
}

interface KoiosStakingEpochParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  coins_per_utxo_size: string | number;
  key_deposit: string | number;
  drep_deposit: string | number | null;
}

interface KoiosAccountInfo {
  stake_address: string;
  status: string;
  delegated_pool: string | null;
  delegated_drep: string | null;
  rewards_available: string | null;
  rewards: string | null;
  withdrawals: string | null;
  deposit: string | null;
}

interface KoiosAccountReward {
  earned_epoch: number;
  spendable_epoch: number;
  amount: string;
  type: string | null;
  pool_id: string | null;
}

interface KoiosAccountRewardsRow {
  stake_address: string;
  rewards: KoiosAccountReward[] | null;
}

interface KoiosAccountUpdate {
  stake_address: string;
  updates: { action_type: string; tx_hash: string; absolute_slot: number }[] | null;
}

interface KoiosPoolInfo {
  pool_id_bech32: string;
  pool_status: string;
  retiring_epoch: number | null;
  active_stake: string | null;
}

interface KoiosDRepInfo {
  drep_id: string;
  hex: string;
  has_script: boolean;
  registered: boolean;
  active: boolean;
  expires_epoch_no: number | null;
  amount: string | null;
}

/**
 * Koios as the staking provider.
 *
 * Its stake reads are POST endpoints taking arrays of addresses, which is why every method here
 * asks for one address and then insists the answer be about that address: a batch endpoint returns
 * the rows it found, in the order it found them, and will happily return zero rows for an address
 * with no history — reading row zero without checking is how one credential's rewards get written
 * onto another's account.
 *
 * **This dialect has not been exercised against a live endpoint.** The deployment reads through
 * Blockfrost, and the shapes below come from the Koios contract rather than from responses this
 * code has seen. The tests pin the normalisation, not the contract.
 */
export class KoiosStakingProvider extends HttpCardanoProvider implements CardanoStakingProvider {
  /**
   * Koios takes its token as a JWT bearer and takes its absence as a request for the public tier.
   *
   * @returns The authorization header, or nothing when no token is configured.
   */
  protected authHeaders(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }

  /**
   * The epoch the chain is in.
   *
   * @returns The epoch number.
   * @throws CardanoProviderError On any provider failure.
   */
  async currentEpoch(): Promise<number> {
    const rows = await this.call<KoiosTipRow[]>('/tip');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return requiredInteger(row?.epoch_no, 'epoch_no');
  }

  /**
   * Protocol parameters, staking deposits included.
   *
   * @returns The six values a staking transaction needs.
   * @throws CardanoProviderError On any provider failure, or when a field is missing.
   */
  async stakingProtocolParameters(): Promise<CardanoStakingProtocolParameters> {
    const rows = await this.call<KoiosStakingEpochParams[]>('/epoch_params?limit=1');
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row.min_fee_a !== 'number' || typeof row.min_fee_b !== 'number') {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_PARAMETERS_SHAPE');
    }
    return {
      minFeeA: row.min_fee_a,
      minFeeB: row.min_fee_b,
      coinsPerUtxoByte: BigInt(row.coins_per_utxo_size),
      maxTxSize: Number(row.max_tx_size),
      stakeAddressDeposit: requiredLovelace(row.key_deposit, 'key_deposit'),
      // Absent on a chain whose era predates governance. Zero is the honest reading there, and no
      // path in this backend registers a DRep, so it is never spent from.
      drepDeposit: optionalLovelace(row.drep_deposit, 'drep_deposit') ?? 0n
    };
  }

  /**
   * The state of one stake account.
   *
   * @param rewardAddress - Bech32 reward address.
   * @returns What the chain has for it. An address with no row is an unregistered credential
   *   rather than a failure: a wallet that has never staked has no row.
   * @throws CardanoProviderError On any provider failure, or when a field cannot be read.
   */
  async stakeAccount(rewardAddress: string): Promise<CardanoStakeAccountState> {
    const rows = await this.call<KoiosAccountInfo[]>('/account_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _stake_addresses: [rewardAddress] })
    });
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_ACCOUNT_SHAPE');
    }
    // Asked for by address rather than taken from position zero. A batch endpoint answers with the
    // rows it found; an empty answer for one address and a row for another are the same shape.
    const row = rows.find((entry) => entry.stake_address === rewardAddress);
    if (row === undefined) return unregisteredAccount();

    const registered = readKoiosStatus(row.status);
    return {
      registered,
      poolId: row.delegated_pool ?? null,
      governanceDelegation: normalizeGovernanceDelegation(row.delegated_drep, registered),
      // A registered credential always has a figure here, even when it is zero. Its absence is a
      // contract that changed, and reading it as zero would hide rewards the user owns.
      withdrawableRewardsLovelace: registered
        ? requiredLovelace(row.rewards_available, 'rewards_available')
        : 0n,
      lifetimeRewardsLovelace: optionalLovelace(row.rewards, 'rewards'),
      withdrawnLovelace: optionalLovelace(row.withdrawals, 'withdrawals'),
      depositLovelace: optionalLovelace(row.deposit, 'deposit')
    };
  }

  /**
   * Every reward credit this account has received.
   *
   * @param rewardAddress - Bech32 reward address.
   * @returns The credits, and whether paging reached the end.
   * @throws CardanoProviderError On any provider failure, or when a field cannot be read.
   */
  async rewardHistory(rewardAddress: string): Promise<CardanoRewardHistory> {
    const credits: CardanoRewardCredit[] = [];
    for (let page = 0; page < MAX_REWARD_PAGES; page += 1) {
      const rows = await this.call<KoiosAccountRewardsRow[]>(
        `/account_rewards?offset=${page * REWARD_PAGE_SIZE}&limit=${REWARD_PAGE_SIZE}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ _stake_addresses: [rewardAddress] })
        }
      );
      if (!Array.isArray(rows)) {
        throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_REWARDS_SHAPE');
      }
      const batch = rows
        .filter((entry) => entry.stake_address === rewardAddress)
        .flatMap((entry) => entry.rewards ?? []);
      for (const reward of batch) {
        const epoch = requiredInteger(reward.spendable_epoch, 'spendable_epoch');
        credits.push({
          epoch,
          amountLovelace: requiredLovelace(reward.amount, 'amount'),
          sourceType: reward.type ?? null,
          sourceKey: rewardSourceKey(reward.type ?? null, reward.pool_id ?? null, epoch)
        });
      }
      if (batch.length < REWARD_PAGE_SIZE) return { credits, completeness: 'complete' };
    }
    return { credits, completeness: 'partial' };
  }

  /**
   * Every registration and deregistration this credential has been through.
   *
   * This dialect reports the updates but not the deposit each one locked, so the records come back
   * with `depositLovelace: null` and the figure has to come from `account_info.deposit`, which it
   * does report for the registration currently in force.
   *
   * @param rewardAddress - Bech32 reward address.
   * @returns The records, each without a deposit figure.
   * @throws CardanoProviderError On any provider failure, or when a field cannot be read.
   */
  async registrationHistory(
    rewardAddress: string
  ): Promise<readonly CardanoRegistrationRecord[]> {
    const rows = await this.call<KoiosAccountUpdate[]>('/account_updates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _stake_addresses: [rewardAddress] })
    });
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_REGISTRATION_SHAPE');
    }
    return rows
      .filter((entry) => entry.stake_address === rewardAddress)
      .flatMap((entry) => entry.updates ?? [])
      .filter((update) => /^(de)?registration$/i.test(String(update.action_type)))
      .map((update) => ({
        action: readRegistrationAction(update.action_type),
        txHash: String(update.tx_hash ?? ''),
        depositLovelace: null,
        slot: typeof update.absolute_slot === 'number' ? update.absolute_slot : null
      }));
  }

  /**
   * Where a pool stands.
   *
   * @param poolId - Bech32 `pool1…`.
   * @returns Its state, or `null` when the provider does not know the pool.
   * @throws CardanoProviderError On any provider failure.
   */
  async poolState(poolId: string): Promise<CardanoPoolState | null> {
    const rows = await this.call<KoiosPoolInfo[]>('/pool_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _pool_bech32_ids: [poolId] })
    });
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_POOL_SHAPE');
    }
    const row = rows.find((entry) => entry.pool_id_bech32 === poolId);
    if (row === undefined) return null;
    return {
      poolId,
      retirementScheduled: readKoiosPoolStatus(row.pool_status),
      retiringEpoch: row.retiring_epoch ?? null,
      activeStakeLovelace: optionalLovelace(row.active_stake, 'active_stake')
    };
  }

  /**
   * One DRep.
   *
   * @param id - The identifier, in any spelling this backend reads.
   * @returns The DRep, or `null` when the provider does not know it.
   * @throws CardanoProviderError On any provider failure, or when the identifier is unreadable.
   */
  async drepState(id: string): Promise<CardanoDRepState | null> {
    const parsed = parseDRepId(id);
    if (parsed === null) {
      throw new CardanoProviderError(
        'unexpected_response',
        `CARDANO_PROVIDER_DREP_UNREADABLE: ${id.slice(0, 80)}`
      );
    }
    const rows = await this.call<KoiosDRepInfo[]>('/drep_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _drep_ids: [parsed.idCip129] })
    });
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_DREP_SHAPE');
    }
    const row = rows[0];
    if (row === undefined) return null;
    return drepFrom(
      row.drep_id ?? parsed.idCip129,
      readDRepStatus(row.registered === false, row.active === false),
      optionalLovelace(row.amount, 'amount')
    );
  }

  /**
   * DReps available to delegate to.
   *
   * @param limit - How many to return.
   * @returns The DReps that can still use a delegation. Retired and expired ones are left out:
   *   offering either hands a user's voice to something that cannot exercise it.
   * @throws CardanoProviderError On any provider failure.
   */
  async listDReps(limit: number): Promise<readonly CardanoDRepState[]> {
    const rows = await this.call<KoiosDRepInfo[]>(`/drep_list?limit=${limit}`);
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_DREP_SHAPE');
    }
    return rows
      .filter((row) => !isPredefinedTarget(row.drep_id))
      .filter((row) => row.registered !== false && row.active !== false)
      .map((row) => drepFrom(row.drep_id, 'active', optionalLovelace(row.amount, 'amount')));
  }
}

interface BlockfrostEpoch {
  epoch: number;
}

interface BlockfrostStakingEpochParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  coins_per_utxo_size: string | number | null;
  key_deposit: string | number;
  drep_deposit: string | number | null;
}

interface BlockfrostAccount {
  stake_address: string;
  active: boolean;
  registered?: boolean;
  pool_id: string | null;
  drep_id: string | null;
  withdrawable_amount: string | null;
  rewards_sum: string | null;
  withdrawals_sum: string | null;
}

interface BlockfrostReward {
  epoch: number;
  amount: string;
  pool_id: string | null;
  type: string | null;
}

interface BlockfrostPool {
  retirement: string[] | null;
  active_stake: string | null;
}

interface BlockfrostRegistration {
  tx_hash: string;
  action: string;
  deposit: string | number | null;
  tx_slot: number | null;
}

interface BlockfrostDRep {
  drep_id: string;
  hex: string;
  has_script: boolean;
  amount: string | null;
  retired?: boolean;
  expired?: boolean;
}

/**
 * Blockfrost as the staking provider, and the dialect this deployment actually reads.
 *
 * Three things about it decided how the code below is shaped, and all three were read off the
 * configured Preprod root rather than assumed.
 *
 * A stake account answers `200` for an address that has never been used, with both flags false —
 * it does not answer `404` — so "unregistered" arrives as data rather than as an absence, while a
 * malformed address arrives as `400` and stays an error. A DRep's `hex` is the **CIP-129 payload**,
 * header byte included, so it is 29 bytes and not the credential it looks like; the identifier is
 * parsed instead. And no endpoint here reports the deposit a credential has locked, which is why
 * the refund a deregistration owes has to come from the registration this backend confirmed.
 */
export class BlockfrostStakingProvider
  extends HttpCardanoProvider
  implements CardanoStakingProvider
{
  /**
   * Blockfrost takes its project id in a header of that name and refuses every call without one.
   *
   * @returns The project id header, or nothing when none is configured.
   */
  protected authHeaders(): Record<string, string> {
    return this.apiKey ? { project_id: this.apiKey } : {};
  }

  /**
   * The epoch the chain is in.
   *
   * @returns The epoch number.
   * @throws CardanoProviderError On any provider failure.
   */
  async currentEpoch(): Promise<number> {
    const row = await this.call<BlockfrostEpoch>('/epochs/latest');
    return requiredInteger(row?.epoch, 'epoch');
  }

  /**
   * Protocol parameters, staking deposits included.
   *
   * @returns The six values a staking transaction needs.
   * @throws CardanoProviderError On any provider failure, or when a field is missing.
   */
  async stakingProtocolParameters(): Promise<CardanoStakingProtocolParameters> {
    const row = await this.call<BlockfrostStakingEpochParams>('/epochs/latest/parameters');
    const coinsPerUtxoSize = row?.coins_per_utxo_size;
    if (
      !row ||
      typeof row.min_fee_a !== 'number' ||
      typeof row.min_fee_b !== 'number' ||
      coinsPerUtxoSize === null ||
      coinsPerUtxoSize === undefined
    ) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_PARAMETERS_SHAPE');
    }
    return {
      minFeeA: row.min_fee_a,
      minFeeB: row.min_fee_b,
      coinsPerUtxoByte: BigInt(coinsPerUtxoSize),
      maxTxSize: Number(row.max_tx_size),
      stakeAddressDeposit: requiredLovelace(row.key_deposit, 'key_deposit'),
      drepDeposit: optionalLovelace(row.drep_deposit, 'drep_deposit') ?? 0n
    };
  }

  /**
   * The state of one stake account.
   *
   * @param rewardAddress - Bech32 reward address.
   * @returns What the chain has for it.
   * @throws CardanoProviderError On any provider failure, or when a field cannot be read. A
   *   malformed address is a `400` and stays a failure; it is not an unregistered credential.
   */
  async stakeAccount(rewardAddress: string): Promise<CardanoStakeAccountState> {
    const row = await this.callOptional<BlockfrostAccount>(
      `/accounts/${encodeURIComponent(rewardAddress)}`
    );
    if (row === null) return unregisteredAccount();

    const registered = readRegistrationFlags(row.registered, row.active);
    return {
      registered,
      poolId: row.pool_id ?? null,
      governanceDelegation: normalizeGovernanceDelegation(row.drep_id, registered),
      withdrawableRewardsLovelace: registered
        ? requiredLovelace(row.withdrawable_amount, 'withdrawable_amount')
        : 0n,
      lifetimeRewardsLovelace: optionalLovelace(row.rewards_sum, 'rewards_sum'),
      withdrawnLovelace: optionalLovelace(row.withdrawals_sum, 'withdrawals_sum'),
      // This dialect reports no deposit. The refund a deregistration owes has to come from the
      // registration this backend confirmed, which is why it is recorded there at all.
      depositLovelace: null
    };
  }

  /**
   * Every reward credit this account has received.
   *
   * @param rewardAddress - Bech32 reward address.
   * @returns The credits, and whether paging reached the end.
   * @throws CardanoProviderError On any provider failure, or when a field cannot be read.
   */
  async rewardHistory(rewardAddress: string): Promise<CardanoRewardHistory> {
    const credits: CardanoRewardCredit[] = [];
    for (let page = 1; page <= MAX_REWARD_PAGES; page += 1) {
      const rows = await this.callOptional<BlockfrostReward[]>(
        `/accounts/${encodeURIComponent(rewardAddress)}/rewards?count=${REWARD_PAGE_SIZE}&page=${page}`
      );
      if (rows === null) return { credits, completeness: 'complete' };
      if (!Array.isArray(rows)) {
        throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_REWARDS_SHAPE');
      }
      for (const reward of rows) {
        const epoch = requiredInteger(reward.epoch, 'epoch');
        credits.push({
          epoch,
          amountLovelace: requiredLovelace(reward.amount, 'amount'),
          sourceType: reward.type ?? null,
          sourceKey: rewardSourceKey(reward.type ?? null, reward.pool_id ?? null, epoch)
        });
      }
      if (rows.length < REWARD_PAGE_SIZE) return { credits, completeness: 'complete' };
    }
    return { credits, completeness: 'partial' };
  }

  /**
   * Every registration and deregistration this credential has been through.
   *
   * @param rewardAddress - Bech32 reward address.
   * @returns The records, oldest first, each carrying the deposit it locked.
   * @throws CardanoProviderError On any provider failure, or when a field cannot be read.
   */
  async registrationHistory(
    rewardAddress: string
  ): Promise<readonly CardanoRegistrationRecord[]> {
    const rows = await this.callOptional<BlockfrostRegistration[]>(
      `/accounts/${encodeURIComponent(rewardAddress)}/registrations?count=${REWARD_PAGE_SIZE}&page=1`
    );
    if (rows === null) return [];
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_REGISTRATION_SHAPE');
    }
    return rows.map((row) => ({
      action: readRegistrationAction(row.action),
      txHash: String(row.tx_hash ?? ''),
      depositLovelace: optionalLovelace(row.deposit, 'deposit'),
      slot: typeof row.tx_slot === 'number' ? row.tx_slot : null
    }));
  }

  /**
   * Where a pool stands.
   *
   * @param poolId - Bech32 `pool1…`.
   * @returns Its state, or `null` when the provider does not know the pool. `retiringEpoch` is
   *   always `null` here: this dialect reports retirement as the certificates it has seen, which
   *   says that one exists and not when it takes effect. See {@link CardanoPoolState}.
   * @throws CardanoProviderError On any provider failure.
   */
  async poolState(poolId: string): Promise<CardanoPoolState | null> {
    const row = await this.callOptional<BlockfrostPool>(`/pools/${encodeURIComponent(poolId)}`);
    if (row === null) return null;
    const retirement = Array.isArray(row.retirement) ? row.retirement : [];
    return {
      poolId,
      retirementScheduled: retirement.length > 0,
      retiringEpoch: null,
      activeStakeLovelace: optionalLovelace(row.active_stake, 'active_stake')
    };
  }

  /**
   * One DRep.
   *
   * @param id - The identifier, in any spelling this backend reads.
   * @returns The DRep, or `null` when the provider does not know it.
   * @throws CardanoProviderError On any provider failure, or when the identifier is unreadable.
   */
  async drepState(id: string): Promise<CardanoDRepState | null> {
    const parsed = parseDRepId(id);
    if (parsed === null) {
      throw new CardanoProviderError(
        'unexpected_response',
        `CARDANO_PROVIDER_DREP_UNREADABLE: ${id.slice(0, 80)}`
      );
    }
    const row = await this.callOptional<BlockfrostDRep>(
      `/governance/dreps/${encodeURIComponent(parsed.idCip129)}`
    );
    if (row === null) return null;
    return drepFrom(
      row.drep_id ?? parsed.idCip129,
      readDRepStatus(row.retired, row.expired),
      optionalLovelace(row.amount, 'amount')
    );
  }

  /**
   * DReps available to delegate to.
   *
   * @param limit - How many to return.
   * @returns The DReps that can still use a delegation, the two predefined targets excluded —
   *   those are a `kind` of their own in this domain, not credentials.
   * @throws CardanoProviderError On any provider failure.
   */
  async listDReps(limit: number): Promise<readonly CardanoDRepState[]> {
    const rows = await this.call<BlockfrostDRep[]>(`/governance/dreps?count=${limit}&page=1`);
    if (!Array.isArray(rows)) {
      throw new CardanoProviderError('unexpected_response', 'CARDANO_PROVIDER_DREP_SHAPE');
    }
    return rows
      .filter((row) => !isPredefinedTarget(row.drep_id))
      .map((row) =>
        drepFrom(
          row.drep_id,
          readDRepStatus(row.retired, row.expired),
          optionalLovelace(row.amount, 'amount')
        )
      )
      .filter((drep) => drep.status === 'active');
  }
}

/**
 * The state of a credential the chain has never seen.
 *
 * @returns An unregistered account, with every amount at zero and nothing inferred.
 */
function unregisteredAccount(): CardanoStakeAccountState {
  return {
    registered: false,
    poolId: null,
    governanceDelegation: { kind: 'not_registered' },
    withdrawableRewardsLovelace: 0n,
    lifetimeRewardsLovelace: null,
    withdrawnLovelace: null,
    depositLovelace: null
  };
}

/**
 * Reads a registration record's action.
 *
 * @param action - The reported action.
 * @returns Which of the two it is.
 * @throws CardanoProviderError `unexpected_response` for anything else. An unreadable action would
 *   have to be guessed at, and guessing wrong here means reading a deregistration as the
 *   registration whose deposit an exit must refund.
 */
export function readRegistrationAction(action: unknown): 'registered' | 'deregistered' {
  const normalized = typeof action === 'string' ? action.toLowerCase().replace(/[^a-z]/g, '') : '';
  if (normalized === 'registered' || normalized === 'registration') return 'registered';
  if (normalized === 'deregistered' || normalized === 'deregistration') return 'deregistered';
  throw new CardanoProviderError(
    'unexpected_response',
    `CARDANO_PROVIDER_REGISTRATION_ACTION_UNREADABLE: ${String(action).slice(0, 40)}`
  );
}

/**
 * The deposit a credential currently has locked, from its registration history.
 *
 * Reads the record that is still in force: the last registration with no deregistration after it.
 * A credential that registered, exited and registered again locked a deposit at the price of the
 * *second* registration, and the first record's figure would refund the wrong amount.
 *
 * @param records - The history, in any order.
 * @returns The deposit in force, or `null` when the credential is not currently registered or the
 *   provider did not report a figure. `null` is a refusal to guess, not a zero.
 */
export function depositInForce(records: readonly CardanoRegistrationRecord[]): bigint | null {
  // Ordered here rather than trusting the provider's order: a page read newest-first and one read
  // oldest-first are both plausible, and the difference decides which record is "last".
  const ordered = [...records].sort((left, right) => (left.slot ?? 0) - (right.slot ?? 0));
  const last = ordered[ordered.length - 1];
  if (last === undefined || last.action !== 'registered') return null;
  return last.depositLovelace;
}

/**
 * Reads Koios's registration status.
 *
 * @param status - The reported status.
 * @returns Whether the credential is registered.
 * @throws CardanoProviderError `unexpected_response` for anything else. A status this adapter
 *   cannot read is not an unregistered credential — and treating it as one invites a second
 *   registration, and a second deposit, for a credential already registered.
 */
export function readKoiosStatus(status: unknown): boolean {
  const normalized = typeof status === 'string' ? status.toLowerCase().replace(/[^a-z]/g, '') : '';
  if (normalized === 'registered') return true;
  if (normalized === 'notregistered') return false;
  throw new CardanoProviderError(
    'unexpected_response',
    `CARDANO_PROVIDER_ACCOUNT_STATUS_UNREADABLE: ${String(status).slice(0, 40)}`
  );
}

/**
 * Reads Koios's pool status string.
 *
 * @param status - The reported status.
 * @returns Whether a retirement is on record.
 * @throws CardanoProviderError `unexpected_response` for anything else. Defaulting to "no
 *   retirement" would keep delegating users to a pool that has already stopped paying rewards.
 */
export function readKoiosPoolStatus(status: unknown): boolean {
  const normalized = typeof status === 'string' ? status.toLowerCase() : '';
  if (normalized === 'registered') return false;
  if (normalized === 'retiring' || normalized === 'retired') return true;
  throw new CardanoProviderError(
    'unexpected_response',
    `CARDANO_PROVIDER_POOL_STATUS_UNREADABLE: ${String(status).slice(0, 40)}`
  );
}

/**
 * Builds the staking provider this deployment reads through.
 *
 * @param kind - Which dialect to speak.
 * @param baseUrl - Provider root for the network.
 * @param timeoutMs - Per-call ceiling.
 * @param apiKey - Credential, empty when the provider needs none.
 * @returns A staking provider bound to that root.
 */
export function buildStakingProvider(
  kind: CardanoProviderKind,
  baseUrl: string,
  timeoutMs: number,
  apiKey: string
): CardanoStakingProvider {
  return kind === 'blockfrost'
    ? new BlockfrostStakingProvider(baseUrl, timeoutMs, apiKey)
    : new KoiosStakingProvider(baseUrl, timeoutMs, apiKey);
}
