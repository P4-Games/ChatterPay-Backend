import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import type { ICardanoStakingAccount } from '../../../src/models/cardanoStakingAccountModel';
import {
  decideAutomaticAction,
  decideRequestedAction,
  type StakingDecisionContext
} from '../../../src/services/cardano/cardanoStakingPlanService';
import type { CardanoStakingProtocolParameters } from '../../../src/services/cardano/cardanoStakingProviderService';

/**
 * How often ChatterPay will pay to put the same credential back on chain.
 *
 * Registering a stake credential costs a network fee that the sponsor pays, and the deposit is the
 * user's and comes back to them. So a wallet that joins, leaves, is funded again and rejoins costs
 * ChatterPay a fee every turn and costs the user nothing — and from inside the system each turn
 * looks like an ordinary enrolment. Nothing else bounds it except the daily fee budget, and
 * reaching that stops enrolment for *everybody*, which turns one wallet's churn into an outage.
 *
 * The property that matters just as much is the one this limit must never acquire: it bounds entry
 * and only entry. Withdrawing rewards, deregistering and leaving with the balance are decided
 * elsewhere and never consult it. A limit that could strand somebody's ada inside a position they
 * are trying to leave would be a far worse failure than the cost it saves.
 */

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
    preference: { enabled: true, version: 1, updatedAt: new Date() },
    termsConsent: { version: 'v1', acceptedAt: new Date(), source: 'web' },
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

/** A registered credential, delegated, with rewards waiting and a deposit recorded. */
const REGISTERED = {
  registered: true,
  poolId: POOL,
  governanceDelegation: { kind: 'always_abstain', drepId: null },
  depositLovelace: '2000000',
  registrationOrigin: 'chatterpay',
  withdrawableRewardsLovelace: '3000000'
};

describe('the sweep and the sponsored re-entry limit', () => {
  it('enrols a wallet that has not used the window up', () => {
    const decision = decideAutomaticAction(
      account(),
      context({ sponsoredRegistrationsInWindow: 1 })
    );

    expect(decision.action).toBe('register_and_delegate');
  });

  it('refuses the registration that would exceed the limit', () => {
    const decision = decideAutomaticAction(
      account(),
      context({ sponsoredRegistrationsInWindow: 2 })
    );

    expect(decision.action).toBe('none');
    expect(decision.refusal).toBe('sponsored_reentry_limit');
  });

  it('refuses a count already past the limit', () => {
    // The limit could have been lowered after the registrations happened.
    const decision = decideAutomaticAction(
      account(),
      context({ sponsoredRegistrationsInWindow: 9 })
    );

    expect(decision.refusal).toBe('sponsored_reentry_limit');
  });

  it('says how many and over what window, so the refusal is actionable', () => {
    const decision = decideAutomaticAction(
      account(),
      context({ sponsoredRegistrationsInWindow: 4, config: config({ sponsorWindowDays: 7 }) })
    );

    expect(decision.detail).toContain('4');
    expect(decision.detail).toContain('7d');
  });

  it('enrols nobody when the limit is zero', () => {
    // A usable state while a rollout is prepared, and deliberately not read as "unlimited".
    const decision = decideAutomaticAction(
      account(),
      context({ config: config({ maxSponsoredRegistrationsPerWindow: 0 }) })
    );

    expect(decision.refusal).toBe('sponsored_reentry_limit');
  });

  it('reports the reason belonging to the wallet first when it has one', () => {
    // An account refused for its own reasons should be told that, rather than being told it used up
    // a budget it never reached. Otherwise the operator chases the wrong setting.
    const decision = decideAutomaticAction(
      account(),
      context({ spendableLovelace: 1_000_000n, sponsoredRegistrationsInWindow: 9 })
    );

    expect(decision.refusal).toBe('not_eligible');
  });
});

describe('what the limit must never touch', () => {
  it('still withdraws rewards for a wallet over the limit', () => {
    // The user's own money. It was never ChatterPay's to withhold, and the fee for the withdrawal is
    // not a re-entry.
    const decision = decideAutomaticAction(
      account(REGISTERED),
      context({ sponsoredRegistrationsInWindow: 99 })
    );

    expect(decision.action).toBe('withdraw_rewards');
  });

  it('still lets a wallet over the limit leave', () => {
    const decision = decideRequestedAction(
      account({ ...REGISTERED, withdrawableRewardsLovelace: '0' }),
      'deregister',
      context({ sponsoredRegistrationsInWindow: 99 })
    );

    expect(decision.action).toBe('deregister');
  });

  it('still lets a wallet over the limit leave with its balance', () => {
    const decision = decideRequestedAction(
      account({ ...REGISTERED, withdrawableRewardsLovelace: '0' }),
      'exit_and_send_max',
      context({ sponsoredRegistrationsInWindow: 99 })
    );

    expect(decision.action).toBe('exit_and_send_max');
  });

  it('still returns the deposit of a wallet over the limit', () => {
    // Leaving is what refunds the deposit, so the previous case is the one that matters — but the
    // refund is the part a limit could plausibly be thought to withhold, and it is not withheld.
    const decision = decideRequestedAction(
      account({ ...REGISTERED, withdrawableRewardsLovelace: '0', depositLovelace: '2000000' }),
      'deregister',
      context({ sponsoredRegistrationsInWindow: 99 })
    );

    expect(decision.action).toBe('deregister');
    expect(decision.refusal).toBeNull();
  });

  it('still withdraws rewards for a wallet over the limit that also opted out', () => {
    // Both refusals at once, and neither is a reason to keep somebody's ada.
    const decision = decideAutomaticAction(
      account(REGISTERED, {
        optOut: { at: new Date(), reason: 'user_request', source: 'web', preferenceVersion: 1 }
      }),
      context({ sponsoredRegistrationsInWindow: 99 })
    );

    expect(decision.action).toBe('withdraw_rewards');
  });
});

describe('a user asking for it themselves', () => {
  it('is refused past the limit, because ChatterPay pays the fee either way', () => {
    const decision = decideRequestedAction(
      account(),
      'register_and_delegate',
      context({ sponsoredRegistrationsInWindow: 2 })
    );

    expect(decision.refusal).toBe('sponsored_reentry_limit');
  });

  it('is allowed below it', () => {
    const decision = decideRequestedAction(
      account(),
      'register_and_delegate',
      context({ sponsoredRegistrationsInWindow: 1 })
    );

    expect(decision.action).toBe('register_and_delegate');
  });

  it('is told it is already registered before it is told about the limit', () => {
    // A registered wallet is not re-entering anything, and the limit is not the reason to refuse it.
    const decision = decideRequestedAction(
      account(REGISTERED),
      'register_and_delegate',
      context({ sponsoredRegistrationsInWindow: 99 })
    );

    expect(decision.refusal).toBe('already_registered');
  });
});
