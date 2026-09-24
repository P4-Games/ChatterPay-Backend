import mongoose, { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import CardanoStakingAccount, {
  type ICardanoStakingAccount
} from '../../../src/models/cardanoStakingAccountModel';
import { STAKING_COLLECTIONS } from '../../../src/models/cardanoStakingCollections';
import CardanoStakingOperation from '../../../src/models/cardanoStakingOperationModel';
import {
  checkStakingOperationReadiness,
  resetStakingSchemaVerification
} from '../../../src/services/cardano/cardanoStakingOperationService';
import {
  decideAutomaticAction,
  type StakingDecisionContext
} from '../../../src/services/cardano/cardanoStakingPlanService';
import type { CardanoStakingProtocolParameters } from '../../../src/services/cardano/cardanoStakingProviderService';
import { deriveStakingAccountState } from '../../../src/services/cardano/cardanoStakingStateService';

/**
 * Staking that happens without being asked for, and the one thing that still stops it.
 *
 * The product decision these tests pin is that a wallet nobody ever asked is not a wallet that said
 * no. Where this deployment does not require the terms to have been accepted, the absence of a
 * consent and the absence of a preference are the absence of a decision, and the sweep enrols on
 * the technical and economic checks alone — the balance, the signer, the allowlist, the on-chain
 * state and what ChatterPay is willing to spend.
 *
 * The asymmetry is the whole design. Consent is a record that may never have been created; an
 * opt-out is a decision somebody made. No setting turns the second into the first, so an opt-out
 * outranks the balance, later deposits, a consent still on file from before, and the sweep itself.
 *
 * Two windows exist in which that could still be got wrong, and both are closed here rather than by
 * one of them. The sweep decides on a snapshot and acts later, so an opt-out written in between
 * would be invisible to the decision — checked again at the last point before anything is created.
 * And an exit writes its opt-out before it builds anything, so a run that fails half way through
 * leaves the wallet marked out rather than marked in.
 */

/**
 * The staking configuration the readiness check reads.
 *
 * Mocked rather than driven through the environment because the environment is read once, at import
 * time, and these cases need the setting to differ between two tests in the same file. Hoisted so
 * the module mock below — which vitest lifts above the imports — can see it.
 */
const stakingConfig = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../../src/config/cardanoStakingConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/cardanoStakingConfig')>();
  return {
    ...actual,
    getCardanoStakingConfig: () => stakingConfig.current ?? actual.getCardanoStakingConfig()
  };
});

/** A pool id shaped like the real thing. */
const POOL = 'pool1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

/** Protocol parameters as Preprod reports them. */
const PARAMETERS: CardanoStakingProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384,
  stakeAddressDeposit: 2_000_000n,
  drepDeposit: 500_000_000n
};

/** An address long enough for the minimum-output arithmetic to be real. */
const ADDRESS = new Uint8Array(57).fill(7);

const CHAIN_ID = 900000000001;

/**
 * A staking configuration.
 *
 * @param overrides - What differs.
 * @returns The configuration.
 */
function config(overrides: Partial<CardanoStakingConfig> = {}): CardanoStakingConfig {
  return {
    enabled: true,
    disabledReason: '',
    minimumEnrolmentLovelace: 5_000_000n,
    defaultPoolId: POOL,
    termsVersion: 'v1',
    consentRequired: false,
    feeDailyCapLovelace: 50_000_000n,
    drepOwnEnabled: false,
    enrolmentAllowlist: null,
    maxSponsoredRegistrationsPerWindow: 2,
    sponsorWindowDays: 30,
    ...overrides
  };
}

/**
 * An account, shaped like the document without needing a database.
 *
 * Defaults to the shape the backfill leaves behind for a wallet that existed before staking did:
 * no consent, no preference, nothing on chain. That is the case automatic enrolment is about.
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
    walletAddress: 'addr_test1_the_wallet',
    preference: { enabled: false, version: 0, updatedAt: new Date() },
    termsConsent: null,
    optOut: null,
    onChain: {
      registered: false,
      poolId: null,
      governanceDelegation: null,
      depositLovelace: null,
      registrationOrigin: 'unknown',
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

/**
 * The context a decision is taken in.
 *
 * @param overrides - What differs.
 * @returns The context.
 */
function context(overrides: Partial<StakingDecisionContext> = {}): StakingDecisionContext {
  return {
    config: config(),
    parameters: PARAMETERS,
    addressBytes: ADDRESS,
    spendableLovelace: 10_000_000n,
    poolState: null,
    operationInFlight: false,
    signerAvailable: true,
    sponsoredRegistrationsInWindow: 0,
    ...overrides
  };
}

/** An opt-out, as the exit and the switch both write it. */
function optOut(reason: 'user_exit' | 'user_request' | 'operator' = 'user_request'): unknown {
  return { at: new Date(), reason, source: 'dashboard', preferenceVersion: 1 };
}

describe('a wallet nobody asked', () => {
  it('is enrolled although it has no consent and no preference', () => {
    const decision = decideAutomaticAction(account(), context());

    expect(decision.action).toBe('register_and_delegate');
    expect(decision.refusal).toBeNull();
  });

  it('is enrolled although it predates staking entirely', () => {
    // What the backfill leaves: a wallet that existed before any of this, carrying no staking
    // fields at all beyond the ones the document requires.
    const inherited = account(
      {},
      { preference: { enabled: false, version: 0 }, termsConsent: null }
    );

    expect(decideAutomaticAction(inherited, context()).action).toBe('register_and_delegate');
  });

  it('is enrolled although only the preference is missing', () => {
    const consented = account(
      {},
      { termsConsent: { version: 'v1', acceptedAt: new Date(), source: 'web' } }
    );

    expect(decideAutomaticAction(consented, context()).action).toBe('register_and_delegate');
  });

  it('is enrolled although only the consent is missing', () => {
    const switched = account({}, { preference: { enabled: true, version: 1 } });

    expect(decideAutomaticAction(switched, context()).action).toBe('register_and_delegate');
  });

  it('is still asked, where this deployment says it must be', () => {
    // The setting is what changes, and nothing else. Same account, same balance, same everything.
    const decision = decideAutomaticAction(
      account(),
      context({ config: config({ consentRequired: true }) })
    );

    expect(decision.action).toBe('none');
    expect(decision.refusal).toBe('not_opted_in');
  });
});

describe('what automatic enrolment does not override', () => {
  it('leaves a wallet that has not got enough ada alone', () => {
    const decision = decideAutomaticAction(account(), context({ spendableLovelace: 1_000_000n }));

    expect(decision.action).toBe('none');
    expect(decision.refusal).toBe('not_eligible');
  });

  it('enrols that same wallet once the ada arrives', () => {
    // Pending is a state it leaves by itself. Nothing has to be re-decided by a person, which is
    // the point of the refusal being about the funds rather than about the wallet.
    const poor = account();

    expect(decideAutomaticAction(poor, context({ spendableLovelace: 1_000_000n })).refusal).toBe(
      'not_eligible'
    );
    expect(decideAutomaticAction(poor, context({ spendableLovelace: 10_000_000n })).action).toBe(
      'register_and_delegate'
    );
  });

  it('leaves a wallet outside the rollout alone', () => {
    const decision = decideAutomaticAction(
      account(),
      context({ config: config({ enrolmentAllowlist: ['addr_test1_somebody_else'] }) })
    );

    expect(decision.refusal).toBe('not_allowlisted');
  });

  it('leaves a wallet nobody here can sign for alone', () => {
    expect(decideAutomaticAction(account(), context({ signerAvailable: false })).refusal).toBe(
      'signer_unavailable'
    );
  });

  it('stops at the sponsored-entry limit', () => {
    const decision = decideAutomaticAction(
      account(),
      context({ sponsoredRegistrationsInWindow: 2 })
    );

    expect(decision.refusal).toBe('sponsored_reentry_limit');
  });
});

describe('an opt-out, which is a decision rather than a gap', () => {
  it('keeps a wallet out although consent is not required of anybody', () => {
    const left = account({}, { optOut: optOut() });

    const decision = decideAutomaticAction(left, context());

    expect(decision.action).toBe('none');
    expect(decision.refusal).toBe('opted_out');
  });

  it('keeps it out when new ada arrives', () => {
    // The case this exists for. Money landing in a wallet is not a request to stake it.
    const left = account({}, { optOut: optOut() });

    expect(
      decideAutomaticAction(left, context({ spendableLovelace: 1_000_000_000n })).refusal
    ).toBe('opted_out');
  });

  it('keeps it out when it left by exiting rather than by switching off', () => {
    const left = account({}, { optOut: optOut('user_exit') });

    expect(decideAutomaticAction(left, context()).refusal).toBe('opted_out');
  });

  it('is answered the same way on every pass, so retries and restarts respect it', () => {
    // The decision is a function of what is stored and of nothing else: no memory in the process,
    // no flag set by a previous run. That is what makes a retried delivery and a restarted
    // container reach the same conclusion as the run they are replacing.
    const left = account({}, { optOut: optOut() });

    const answers = [1, 2, 3].map(() => decideAutomaticAction(left, context()).refusal);

    expect(answers).toEqual(['opted_out', 'opted_out', 'opted_out']);
  });

  it('still lets the rewards already earned come back', () => {
    // Leaving is a decision about taking part, not a forfeit of ada that is already the user's.
    const left = account(
      {
        registered: true,
        poolId: POOL,
        governanceDelegation: { kind: 'always_abstain' },
        withdrawableRewardsLovelace: '4000000'
      },
      { optOut: optOut() }
    );

    expect(decideAutomaticAction(left, context()).action).toBe('withdraw_rewards');
  });

  it('is undone by an explicit opt-in and by nothing else', () => {
    const left = account({}, { optOut: optOut() });
    expect(decideAutomaticAction(left, context()).refusal).toBe('opted_out');

    // What `setStakingConsent(accept: true)` writes: the record removed, the preference on.
    const back = account({}, { optOut: null, preference: { enabled: true, version: 2 } });

    expect(decideAutomaticAction(back, context()).action).toBe('register_and_delegate');
  });

  it('does not survive the opt-in only to reappear as a limit', () => {
    // Coming back is still bounded by what ChatterPay pays for, and that is a different answer from
    // "you left". A wallet told `opted_out` after rejoining would be reading a stale record.
    const back = account({}, { optOut: null, preference: { enabled: true, version: 2 } });

    expect(
      decideAutomaticAction(back, context({ sponsoredRegistrationsInWindow: 2 })).refusal
    ).toBe('sponsored_reentry_limit');
  });
});

describe('the state a wallet is shown as', () => {
  it('does not say it is waiting for the user when it is waiting for funds', () => {
    // Under automatic enrolment there is nothing for the user to do, so `awaiting_consent` would be
    // an instruction to act on something that does not exist.
    expect(deriveStakingAccountState(account(), null, 'insufficient', false)).toBe(
      'awaiting_funds'
    );
  });

  it('says it is waiting for the user where the terms are required', () => {
    expect(deriveStakingAccountState(account(), null, 'insufficient', true)).toBe(
      'awaiting_consent'
    );
  });

  it('says a wallet that left is waiting for the user, whatever the setting says', () => {
    // And here it is accurate: what it waits for is an opt-in, which is the only way back.
    const left = account({}, { optOut: optOut() });

    expect(deriveStakingAccountState(left, null, 'sufficient', false)).toBe('awaiting_consent');
    expect(deriveStakingAccountState(left, null, 'sufficient', true)).toBe('awaiting_consent');
  });

  it('defaults to requiring consent when the caller does not say', () => {
    // A caller that has not been taught about the setting must not announce a wallet is on its way
    // in. The safe default is the one that describes less.
    expect(deriveStakingAccountState(account(), null, 'sufficient')).toBe('awaiting_consent');
  });
});

describe('the race between a sweep and somebody leaving', () => {
  /**
   * Builds every declared staking index, the way an administrator does by hand.
   */
  async function installSchema(): Promise<void> {
    for (const { model } of STAKING_COLLECTIONS) await model.createIndexes();
    resetStakingSchemaVerification();
  }

  /**
   * Stores an account the sweep has already read on chain.
   *
   * @param overrides - What differs.
   * @returns The stored account.
   */
  async function seed(overrides: Record<string, unknown> = {}): Promise<ICardanoStakingAccount> {
    return CardanoStakingAccount.create({
      userId: new Types.ObjectId(),
      chainId: CHAIN_ID,
      walletAddress: 'addr_test1qzasn8g8wgz5elr7a2jwcpvy9jdpzddy4vc5xtqpkrl53xw',
      rewardAddress: 'stake_test1urxz7zmqaewyakmme3ryzpu86wy488xa7kmy7qqjxp9erksag4z3l',
      stakeCredentialHex: '7c2f0b60ee5c4edb7bcc46410787d389539cddf5b64f0012304b91da',
      currentLifecycleId: 'cycle-1',
      onChain: {
        registered: false,
        poolId: null,
        governanceDelegation: null,
        depositLovelace: null,
        withdrawableRewardsLovelace: '0',
        pendingRewardsLovelace: '0',
        lifetimeRewardsLovelace: '0',
        historicalCompleteness: 'partial',
        asOf: new Date()
      },
      ...overrides
    });
  }

  beforeEach(async () => {
    stakingConfig.current = config();
    await CardanoStakingAccount.deleteMany({});
    await CardanoStakingOperation.deleteMany({});
    await installSchema();
  });

  afterEach(() => {
    resetStakingSchemaVerification();
  });

  it('refuses a registration decided before the opt-out was written', async () => {
    // The sequence exactly as it happens: the sweep reads the account, observes the chain, assembles
    // a plan — and somewhere in there the user presses the button.
    const stale = await seed();

    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $set: { optOut: optOut() } });

    const readiness = await checkStakingOperationReadiness(stale, 'register_and_delegate');

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.refusal).toBe('opted_out');
  });

  it('refuses every other way of joining decided on the same stale copy', async () => {
    const stale = await seed();
    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $set: { optOut: optOut() } });

    for (const kind of ['delegate_vote', 'redelegate_pool'] as const) {
      const readiness = await checkStakingOperationReadiness(stale, kind);
      expect(readiness.ok).toBe(false);
    }
  });

  it('lets the wallet leave, which is what it asked to do', async () => {
    // The refusal above must not reach the operations that carry the decision out. A wallet that
    // could not deregister because it had opted out would be trapped by its own request.
    const stale = await seed();
    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $set: { optOut: optOut() } });

    for (const kind of ['deregister', 'exit_and_send_max', 'withdraw_rewards'] as const) {
      const readiness = await checkStakingOperationReadiness(stale, kind);
      expect(readiness.ok).toBe(true);
    }
  });

  it('allows the registration when nobody left', async () => {
    const ready = await seed();

    expect((await checkStakingOperationReadiness(ready, 'register_and_delegate')).ok).toBe(true);
  });

  it('does not ask for a consent this deployment does not require', async () => {
    const ready = await seed();

    expect((await checkStakingOperationReadiness(ready, 'register_and_delegate')).ok).toBe(true);
  });

  it('asks for it where the deployment does require it', async () => {
    stakingConfig.current = config({ consentRequired: true });
    const ready = await seed();

    const readiness = await checkStakingOperationReadiness(ready, 'register_and_delegate');

    expect(readiness.ok).toBe(false);
    if (!readiness.ok) expect(readiness.refusal).toBe('no_terms_consent');
  });

  it('allows it again once the wallet has explicitly come back', async () => {
    const stale = await seed();
    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $set: { optOut: optOut() } });
    expect((await checkStakingOperationReadiness(stale, 'register_and_delegate')).ok).toBe(false);

    // What the opt-in writes, and the only thing that writes it.
    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $unset: { optOut: '' } });

    expect((await checkStakingOperationReadiness(stale, 'register_and_delegate')).ok).toBe(true);
  });

  it('reaches the same answer on a retried delivery', async () => {
    // A retry arrives with the same stale copy in hand. It has to re-read, not remember.
    const stale = await seed();
    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $set: { optOut: optOut() } });

    const answers = await Promise.all([
      checkStakingOperationReadiness(stale, 'register_and_delegate'),
      checkStakingOperationReadiness(stale, 'register_and_delegate'),
      checkStakingOperationReadiness(stale, 'register_and_delegate')
    ]);

    expect(answers.every((answer) => !answer.ok)).toBe(true);
  });

  it('reads the database rather than the copy it was handed', async () => {
    // Stated as its own case because it is the mechanism, and a refactor that passed the account
    // through without re-reading would pass every test above except this one.
    const stale = await seed();
    await CardanoStakingAccount.updateOne({ _id: stale._id }, { $set: { optOut: optOut() } });

    expect(stale.optOut ?? null).toBeNull();
    expect((await checkStakingOperationReadiness(stale, 'register_and_delegate')).ok).toBe(false);
  });

  it('is connected to the database it is reading', async () => {
    // Guards the cases above: a readiness check that refused because the connection was down would
    // look identical to one that refused for the right reason.
    expect(mongoose.connection.readyState).toBe(1);
  });
});
