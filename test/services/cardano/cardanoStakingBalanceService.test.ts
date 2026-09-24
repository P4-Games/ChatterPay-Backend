import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { ICardanoStakingAccount } from '../../../src/models/cardanoStakingAccountModel';
import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import {
  resolveStakingBalance,
  type StakingBalanceProvider
} from '../../../src/services/cardano/cardanoStakingBalanceService';
import type { CardanoUtxo } from '../../../src/types/cardanoType';

const ADDRESS = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';

/**
 * An output.
 *
 * @param lovelace - What it holds.
 * @param index - Output index.
 * @param holdsOtherAssets - Whether it also carries tokens, which pins some of its ada.
 * @returns The output.
 */
function utxo(lovelace: bigint, index = 0, holdsOtherAssets = false): CardanoUtxo {
  return { txHash: 'ab'.repeat(32), outputIndex: index, lovelace, holdsOtherAssets };
}

/**
 * A provider reporting fixed outputs.
 *
 * @param utxos - What the address holds.
 * @returns The provider.
 */
function providerWith(utxos: CardanoUtxo[]): StakingBalanceProvider {
  return { utxosFor: async () => utxos };
}

/** A provider that cannot answer. */
const FAILING: StakingBalanceProvider = {
  utxosFor: async () => {
    throw new CardanoProviderError('provider_unavailable', 'provider down');
  }
};

/**
 * An account, shaped like the document without needing a database.
 *
 * @param onChain - The snapshot.
 * @param overrides - Anything else that differs.
 * @returns A stand-in for the account.
 */
function account(
  onChain: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
): ICardanoStakingAccount {
  return {
    _id: new Types.ObjectId(),
    depositEconomicOwner: 'user',
    onChain: {
      registered: true,
      poolId: 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx',
      governanceDelegation: { kind: 'always_abstain' },
      depositLovelace: '2000000',
      registrationOrigin: 'chatterpay',
      withdrawableRewardsLovelace: '0',
      pendingRewardsLovelace: '0',
      lifetimeRewardsLovelace: '0',
      historicalCompleteness: 'complete',
      asOf: new Date(),
      ...onChain
    },
    ...overrides
  } as unknown as ICardanoStakingAccount;
}

describe('resolveStakingBalance', () => {
  it('sums outputs, the refundable deposit and withdrawable rewards', async () => {
    const balance = await resolveStakingBalance(
      account({ withdrawableRewardsLovelace: '8183734' }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.utxoLovelace).toBe(10_000_000n);
    expect(balance.userOwnedRefundableDepositLovelace).toBe(2_000_000n);
    expect(balance.withdrawableRewardsLovelace).toBe(8_183_734n);
    expect(balance.totalAdaLovelace).toBe(20_183_734n);
  });

  it('leaves pending rewards out of the total', async () => {
    // Not withdrawable and still liable to change. Counting them would report money the user cannot
    // touch as money they have.
    const balance = await resolveStakingBalance(
      account({ pendingRewardsLovelace: '5000000' }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.pendingRewardsLovelace).toBe(5_000_000n);
    expect(balance.totalAdaLovelace).toBe(12_000_000n);
  });

  it('does not count a deposit standing against an unregistered credential', async () => {
    const balance = await resolveStakingBalance(
      account({ registered: false, depositLovelace: '2000000' }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.userOwnedRefundableDepositLovelace).toBe(0n);
    expect(balance.totalAdaLovelace).toBe(10_000_000n);
  });

  it("does not count a deposit that is not the user's to reclaim", async () => {
    const balance = await resolveStakingBalance(
      account({}, { depositEconomicOwner: 'sponsor' }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.userOwnedRefundableDepositLovelace).toBe(0n);
  });

  it('refuses to guess a deposit the provider never reported', async () => {
    const balance = await resolveStakingBalance(
      account({ depositLovelace: null }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.userOwnedRefundableDepositLovelace).toBe(0n);
  });

  it('reports nothing at all when the outputs cannot be read', async () => {
    // The point of the whole module. A zero here reads as "the wallet is empty" to anything that
    // does not check availability, and that reading turns an outage into a wrong decision.
    const balance = await resolveStakingBalance(account(), ADDRESS, FAILING);

    expect(balance.availability).toBe('unavailable');
    expect(balance.economicallyUsable).toBe(false);
    expect(balance).not.toHaveProperty('totalAdaLovelace');
  });

  it('is complete for a wallet with no staking account', async () => {
    // Every lovelace is in the outputs, which is known rather than unknown.
    const balance = await resolveStakingBalance(null, ADDRESS, providerWith([utxo(4_000_000n)]));

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.totalAdaLovelace).toBe(4_000_000n);
    expect(balance.economicallyUsable).toBe(true);
  });

  it('refuses to decide on a credential that has never been read', async () => {
    const balance = await resolveStakingBalance(
      account({ asOf: null }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    expect(balance).toMatchObject({ availability: 'stale', reason: 'never_observed' });
    expect(balance.economicallyUsable).toBe(false);
  });

  it('still reports the outputs it does know about while the snapshot is missing', async () => {
    const balance = await resolveStakingBalance(
      account({ asOf: null }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    if (balance.availability === 'unavailable') throw new Error('expected amounts');
    expect(balance.utxoLovelace).toBe(10_000_000n);
  });

  it('refuses to decide on a snapshot older than the sync interval allows', async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const balance = await resolveStakingBalance(
      account({ asOf: twoDaysAgo }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    expect(balance).toMatchObject({ availability: 'stale', reason: 'snapshot_stale' });
    expect(balance.economicallyUsable).toBe(false);
  });

  it('accepts a snapshot from within the day', async () => {
    const balance = await resolveStakingBalance(
      account({ asOf: new Date(Date.now() - 6 * 60 * 60 * 1000) }),
      ADDRESS,
      providerWith([utxo(10_000_000n)])
    );

    expect(balance.availability).toBe('complete');
  });

  it('separates what is spendable from what is merely held', async () => {
    // Ada pinned behind a token is part of the balance and not reachable by a transfer.
    const balance = await resolveStakingBalance(
      account(),
      ADDRESS,
      providerWith([utxo(5_000_000n, 0), utxo(3_000_000n, 1, true)])
    );

    if (balance.availability !== 'complete') throw new Error(balance.availability);
    expect(balance.utxoLovelace).toBe(8_000_000n);
    expect(balance.spendableLovelace).toBeLessThanOrEqual(balance.utxoLovelace);
  });

  it('carries the moment the staking half was read', async () => {
    const asOf = new Date(Date.now() - 60_000);
    const balance = await resolveStakingBalance(
      account({ asOf }),
      ADDRESS,
      providerWith([utxo(1_000_000n)])
    );

    if (balance.availability === 'unavailable') throw new Error('expected amounts');
    expect(balance.asOf?.getTime()).toBe(asOf.getTime());
  });
});
