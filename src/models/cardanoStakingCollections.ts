/**
 * The staking collections as a set, and the index names they declare.
 *
 * One list, read by both the migration that builds the indexes and the guard that refuses to start
 * an economic operation without them. Two lists would drift, and the direction the drift takes is
 * the dangerous one: a guard that checks fewer indexes than the migration installs waves through
 * exactly the deployment where the migration never ran.
 *
 * Nothing here opens a connection or touches a collection. The index names come from the schema
 * objects themselves.
 */

import type { Model } from 'mongoose';

import CardanoStakingAccount from './cardanoStakingAccountModel';
import CardanoStakingDepositEvent from './cardanoStakingDepositEventModel';
import CardanoStakingFeeBudget from './cardanoStakingFeeBudgetModel';
import CardanoStakingGovernanceEvent from './cardanoStakingGovernanceEventModel';
import CardanoStakingOperation from './cardanoStakingOperationModel';
import CardanoStakingReward from './cardanoStakingRewardModel';
import CardanoStakingSponsorFeeEvent from './cardanoStakingSponsorFeeEventModel';
import CardanoStakingSyncRun from './cardanoStakingSyncRunModel';
import CardanoUtxoClaim from './cardanoUtxoClaimModel';

export interface StakingCollection {
  model: Model<never>;
  collection: string;
}

/** Every collection the staking rollout introduces. Order is irrelevant; none references another. */
export const STAKING_COLLECTIONS: readonly StakingCollection[] = [
  {
    model: CardanoStakingAccount as unknown as Model<never>,
    collection: 'cardano_staking_accounts'
  },
  {
    model: CardanoStakingOperation as unknown as Model<never>,
    collection: 'cardano_staking_operations'
  },
  {
    model: CardanoStakingDepositEvent as unknown as Model<never>,
    collection: 'cardano_staking_deposit_events'
  },
  { model: CardanoStakingReward as unknown as Model<never>, collection: 'cardano_staking_rewards' },
  {
    model: CardanoStakingGovernanceEvent as unknown as Model<never>,
    collection: 'cardano_staking_governance_events'
  },
  {
    model: CardanoStakingSponsorFeeEvent as unknown as Model<never>,
    collection: 'cardano_staking_sponsor_fee_events'
  },
  {
    model: CardanoStakingFeeBudget as unknown as Model<never>,
    collection: 'cardano_staking_fee_budget'
  },
  {
    model: CardanoStakingSyncRun as unknown as Model<never>,
    collection: 'cardano_staking_sync_runs'
  },
  // Not introduced by this rollout — transfers have used it all along — but its expiry behaviour is
  // what keeps a staking operation's inputs held while its outcome is unknown, and an index that
  // load-bearing has to be built by the migration and checked by the guard rather than created
  // lazily by whichever process reaches the store first.
  { model: CardanoUtxoClaim as unknown as Model<never>, collection: 'cardano_utxo_claims' }
];

/**
 * The name Mongo will give an index, so that what a schema declares can be compared with what a
 * collection already has.
 *
 * Every index in this rollout is declared with an explicit `name`, which is the whole reason they
 * are: an index compared by its generated name changes identity whenever a key is reordered, and
 * the comparison then reports a missing index that is in fact there. The generated form is kept as
 * a fallback for an index declared without one.
 *
 * @param spec - The index key specification.
 * @param options - Options the index was declared with.
 * @returns The index name.
 */
export function indexName(spec: Record<string, unknown>, options?: { name?: string }): string {
  if (options?.name !== undefined) return options.name;
  return Object.entries(spec)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');
}

/**
 * The index names a model's schema declares.
 *
 * Pure: it reads the schema object and performs no I/O, so it is safe to call before anything is
 * connected and it cannot bring a collection into existence.
 *
 * @param model - Model to read.
 * @returns The declared index names. `_id_` is not among them; no schema declares it.
 */
export function declaredIndexNames(model: Model<never>): string[] {
  return model.schema.indexes().map(([spec, options]) => indexName(spec, options));
}
