import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import type { ICardanoStakingAccount } from '../../../src/models/cardanoStakingAccountModel';
import {
  baseAddress,
  decodeCardanoAddress,
  rewardAddress
} from '../../../src/services/cardano/cardanoAddressService';
import {
  type CardanoCredential,
  encodeDRep
} from '../../../src/services/cardano/cardanoCertificateService';
import {
  type ParsedGovernanceTarget,
  parseGovernanceTarget
} from '../../../src/services/cardano/cardanoGovernanceTargetService';
import {
  buildCardanoStakingTransaction,
  type CardanoStakingPlan,
  certificatesFor,
  withdrawalsFor
} from '../../../src/services/cardano/cardanoStakingBuilderService';
import {
  decideRequestedAction,
  type StakingDecisionContext
} from '../../../src/services/cardano/cardanoStakingPlanService';
import type { CardanoStakingProtocolParameters } from '../../../src/services/cardano/cardanoStakingProviderService';
import type { CardanoProtocolParameters, CardanoUtxo } from '../../../src/types/cardanoType';
import { stakingConfigFixture } from '../../helpers/stakingConfigFixture';

/**
 * Delegating a vote to each of the three targets, from the decision down to the certificate.
 *
 * The approved scope is three targets and until now one of them was reachable. What made the other
 * two unreachable was not the ledger and not the encoder — both have handled all three all along —
 * but the request contract, which named an action and nothing it was aimed at. These cases cover the
 * two halves the target had to be threaded into on this side of the contract: the decision about
 * whether the delegation is worth making, and the transaction it turns into.
 *
 * The property that must hold throughout: **a vote delegation changes the vote and nothing else.**
 * The Conway `vote_deleg_cert` has no field for a pool, so the independence is structural rather than
 * a convention — and it is asserted here anyway, because "structural" is a claim about the certificate
 * this code emits and not only about the one the specification describes.
 */

const USER_PAYMENT = '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636';
const USER_STAKE = '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18';
const SPONSOR_PAYMENT = '0x1111111111111111111111111111111111111111111111111111111111111111';
const SPONSOR_STAKE = '0x2222222222222222222222222222222222222222222222222222222222222222';

const USER_ADDRESS = baseAddress(USER_PAYMENT, USER_STAKE, 'testnet');
const SPONSOR_ADDRESS = baseAddress(SPONSOR_PAYMENT, SPONSOR_STAKE, 'testnet');
const USER_BYTES = decodeCardanoAddress(USER_ADDRESS)?.payload ?? new Uint8Array();
const SPONSOR_BYTES = decodeCardanoAddress(SPONSOR_ADDRESS)?.payload ?? new Uint8Array();
const REWARD_ADDRESS = rewardAddress(USER_STAKE, 'testnet');

const STAKE_CREDENTIAL: CardanoCredential = {
  type: 'key_hash',
  hashHex: 'cc2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da'
};

const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';

/** Two DReps and a script DRep, as bech32 fixtures denoting nobody. */
const DREP_A_CIP129 = 'drep1y242424242424242424242424242424242424242424242sdg97tu';
const DREP_A_CIP105 = 'drep_vkh1424242424242424242424242424242424242424242425xawa90';
const DREP_B_CIP129 = 'drep1y2amhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwcxwkjzd';

const BUILD_PARAMETERS: CardanoProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384
};

const DECISION_PARAMETERS: CardanoStakingProtocolParameters = {
  ...BUILD_PARAMETERS,
  stakeAddressDeposit: 2_000_000n,
  drepDeposit: 500_000_000n
};

/**
 * A parsed target, as a request would produce one.
 *
 * @param raw - The wire target.
 * @returns The parsed target.
 * @throws Error when the fixture does not parse, which would make the case meaningless.
 */
function target(raw: unknown): ParsedGovernanceTarget {
  const result = parseGovernanceTarget(raw, 'delegate_vote');
  if (!result.ok || result.target === null) throw new Error('fixture does not parse');
  return result.target;
}

/**
 * A staking configuration.
 *
 * @param overrides - What differs.
 * @returns The configuration.
 */
function config(overrides: Partial<CardanoStakingConfig> = {}): CardanoStakingConfig {
  return stakingConfigFixture({
    defaultPoolId: POOL,
    termsVersion: 'v1',
    consentRequired: true,
    ...overrides
  });
}

/**
 * An account, shaped like the document without needing a database.
 *
 * @param onChain - The snapshot.
 * @returns A stand-in for the account.
 */
function account(onChain: Record<string, unknown> = {}): ICardanoStakingAccount {
  return {
    _id: new Types.ObjectId(),
    preference: { enabled: true, version: 1, updatedAt: new Date() },
    termsConsent: { version: 'v1', acceptedAt: new Date(), source: 'web' },
    onChain: {
      registered: true,
      poolId: POOL,
      governanceDelegation: null,
      depositLovelace: '2000000',
      registrationOrigin: 'chatterpay',
      withdrawableRewardsLovelace: '0',
      pendingRewardsLovelace: '0',
      lifetimeRewardsLovelace: '0',
      historicalCompleteness: 'complete',
      asOf: new Date(),
      ...onChain
    }
  } as unknown as ICardanoStakingAccount;
}

/**
 * The context a decision is taken in.
 *
 * @param overrides - What differs.
 * @returns The context.
 */
function context(overrides: Partial<StakingDecisionContext> = {}): StakingDecisionContext {
  return {
    config: config(),
    parameters: DECISION_PARAMETERS,
    addressBytes: USER_BYTES,
    spendableLovelace: 10_000_000n,
    poolState: null,
    operationInFlight: false,
    signerAvailable: true,
    sponsoredRegistrationsInWindow: 0,
    ...overrides
  };
}

/**
 * A UTxO.
 *
 * @param seed - Distinguishes the transaction hash.
 * @param lovelace - What it holds.
 * @returns The output.
 */
function utxo(seed: string, lovelace: bigint): CardanoUtxo {
  return {
    txHash: seed.repeat(64).slice(0, 64),
    outputIndex: 0,
    lovelace,
    holdsOtherAssets: false,
    assets: []
  };
}

/**
 * A vote delegation plan.
 *
 * @param overrides - What differs, normally the target.
 * @returns The plan.
 */
function votePlan(overrides: Partial<CardanoStakingPlan> = {}): CardanoStakingPlan {
  return {
    shape: 'delegate_vote',
    parameters: BUILD_PARAMETERS,
    ttlSlot: 900,
    userAddressBytes: USER_BYTES,
    userUtxos: [utxo('a', 10_000_000n)],
    userPaymentKeyHash: 'aa'.repeat(28),
    userStakeKeyHash: STAKE_CREDENTIAL.hashHex,
    stakeCredential: STAKE_CREDENTIAL,
    rewardAddress: REWARD_ADDRESS,
    sponsorAddressBytes: SPONSOR_BYTES,
    sponsorUtxos: [utxo('b', 50_000_000n)],
    sponsorPaymentKeyHash: 'bb'.repeat(28),
    drep: { kind: 'always_abstain' },
    ...overrides
  };
}

// ----------------------------------------------------------------------

describe('deciding a requested vote delegation', () => {
  it('allows each of the three targets on a registered credential', () => {
    for (const raw of [
      { kind: 'always_abstain' },
      { kind: 'always_no_confidence' },
      { kind: 'drep', drep_id: DREP_A_CIP129 }
    ]) {
      const decision = decideRequestedAction(
        account(),
        'delegate_vote',
        context({ governanceTarget: target(raw) })
      );

      expect(decision, JSON.stringify(raw)).toMatchObject({ action: 'delegate_vote' });
    }
  });

  it('refuses one on a credential that is not registered', () => {
    const decision = decideRequestedAction(
      account({ registered: false }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'always_abstain' }) })
    );

    expect(decision).toMatchObject({ action: 'none', refusal: 'not_registered' });
  });

  it('refuses a delegation to where the credential already delegates', () => {
    // A network fee spent to change nothing. Reported as a refusal so the screen can say the wallet is
    // already there rather than offering a transaction that does nothing.
    const decision = decideRequestedAction(
      account({ governanceDelegation: { kind: 'always_abstain' } }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'always_abstain' }) })
    );

    expect(decision).toMatchObject({ action: 'none', refusal: 'already_delegated' });
  });

  it('allows a move from one predefined target to the other', () => {
    const decision = decideRequestedAction(
      account({ governanceDelegation: { kind: 'always_abstain' } }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'always_no_confidence' }) })
    );

    expect(decision).toMatchObject({ action: 'delegate_vote' });
  });

  it('allows a move from a predefined target to a DRep', () => {
    const decision = decideRequestedAction(
      account({ governanceDelegation: { kind: 'always_abstain' } }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'drep', drep_id: DREP_A_CIP129 }) })
    );

    expect(decision).toMatchObject({ action: 'delegate_vote' });
  });

  it('allows a move from one DRep to another', () => {
    const decision = decideRequestedAction(
      account({ governanceDelegation: { kind: 'drep', idCip129: DREP_A_CIP129 } }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'drep', drep_id: DREP_B_CIP129 }) })
    );

    expect(decision).toMatchObject({ action: 'delegate_vote' });
  });

  it('refuses a DRep the credential already follows, written the other way', () => {
    // The reason the comparison decodes rather than compares text: the same DRep is spelled three
    // different ways, and a text comparison would build a transaction that changes nothing.
    const decision = decideRequestedAction(
      account({ governanceDelegation: { kind: 'drep', idCip129: DREP_A_CIP129 } }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'drep', drep_id: DREP_A_CIP105 }) })
    );

    expect(decision).toMatchObject({ action: 'none', refusal: 'already_delegated' });
  });

  it('allows a delegation from a credential that delegates to nobody', () => {
    const decision = decideRequestedAction(
      account({ governanceDelegation: { kind: 'none' } }),
      'delegate_vote',
      context({ governanceTarget: target({ kind: 'always_no_confidence' }) })
    );

    expect(decision).toMatchObject({ action: 'delegate_vote' });
  });

  it('takes the same decision as before when no target is named', () => {
    // The sweep names none - it initiates the neutral delegation and has nothing to be aimed at - so
    // its decision must be unchanged by any of this.
    const decision = decideRequestedAction(account(), 'delegate_vote', context());

    expect(decision).toMatchObject({ action: 'delegate_vote' });
  });
});

// ----------------------------------------------------------------------

describe('the certificate a vote delegation produces', () => {
  it('encodes an abstention as the ledger spells it', () => {
    const certificates = certificatesFor(votePlan({ drep: { kind: 'always_abstain' } }));

    expect(certificates).toEqual([
      { kind: 'delegate_vote', stake: STAKE_CREDENTIAL, drep: { kind: 'always_abstain' } }
    ]);
  });

  it('encodes a vote of no confidence', () => {
    const certificates = certificatesFor(votePlan({ drep: { kind: 'always_no_confidence' } }));

    expect(certificates).toEqual([
      { kind: 'delegate_vote', stake: STAKE_CREDENTIAL, drep: { kind: 'always_no_confidence' } }
    ]);
  });

  it('encodes a delegation to a named DRep', () => {
    const credential = target({ kind: 'drep', drep_id: DREP_A_CIP129 }).drep;
    const certificates = certificatesFor(votePlan({ drep: credential }));

    expect(certificates).toEqual([
      { kind: 'delegate_vote', stake: STAKE_CREDENTIAL, drep: credential }
    ]);
  });

  it('gives the three targets three different encodings', () => {
    // If two of them encoded the same, the ledger would be told the same thing for two different
    // requests and nothing further up would notice.
    const encodings = [
      { kind: 'always_abstain' as const },
      { kind: 'always_no_confidence' as const },
      target({ kind: 'drep', drep_id: DREP_A_CIP129 }).drep,
      target({ kind: 'drep', drep_id: DREP_B_CIP129 }).drep
    ].map((drep) => Buffer.from(encodeDRep(drep)).toString('hex'));

    expect(new Set(encodings).size).toBe(encodings.length);
  });

  it('refuses to build one with no target', () => {
    // Defaulting here is what made abstaining the only reachable target. The builder refuses instead.
    expect(() => certificatesFor(votePlan({ drep: undefined }))).toThrow(
      'CARDANO_STAKING_DREP_REQUIRED'
    );
  });

  it('carries no withdrawal, whatever the reward account holds', () => {
    expect(withdrawalsFor(votePlan({ withdrawalLovelace: 5_000_000n }))).toEqual([]);
  });
});

describe('what a vote delegation leaves alone', () => {
  it('names no pool in the certificate', () => {
    // The independence that matters: delegating a vote must not move the stake delegation. A
    // certificate that named a pool would do exactly that.
    for (const drep of [
      { kind: 'always_abstain' as const },
      { kind: 'always_no_confidence' as const },
      target({ kind: 'drep', drep_id: DREP_A_CIP129 }).drep
    ]) {
      const certificates = certificatesFor(votePlan({ drep, poolId: POOL }));

      expect(certificates).toHaveLength(1);
      expect(certificates[0]).not.toHaveProperty('poolId');
      expect(certificates[0].kind).toBe('delegate_vote');
    }
  });

  it('builds one certificate and only one, even with a pool on the plan', () => {
    // A plan can carry a pool - the account delegates to one - and that must not turn into a second
    // certificate riding along with the delegation the user asked for.
    const built = buildCardanoStakingTransaction(
      votePlan({
        drep: target({ kind: 'drep', drep_id: DREP_A_CIP129 }).drep,
        poolId: POOL
      })
    );

    expect(built.certificates).toHaveLength(1);
    expect(built.certificates[0].kind).toBe('delegate_vote');
    expect(built.withdrawals).toEqual([]);
    expect(built.depositLovelace).toBe(0n);
    expect(built.refundLovelace).toBe(0n);
  });

  it('produces a different transaction for each target', () => {
    // The end-to-end version of the encoding case: the same wallet asking for two different targets
    // must not produce the same transaction.
    const ids = [
      { kind: 'always_abstain' as const },
      { kind: 'always_no_confidence' as const },
      target({ kind: 'drep', drep_id: DREP_A_CIP129 }).drep,
      target({ kind: 'drep', drep_id: DREP_B_CIP129 }).drep
    ].map((drep) => buildCardanoStakingTransaction(votePlan({ drep })).transactionId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('moves no value to anybody', () => {
    // Nothing but a fee. A vote delegation carries no deposit, no refund and no recipient.
    const built = buildCardanoStakingTransaction(
      votePlan({ drep: { kind: 'always_no_confidence' } })
    );

    expect(built.recipientLovelace).toBe(0n);
    expect(built.commercialFeeLovelace).toBe(0n);
    expect(built.withdrawalLovelace).toBe(0n);
  });
});
