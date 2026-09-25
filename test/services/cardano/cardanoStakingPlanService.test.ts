import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import type { ICardanoStakingAccount } from '../../../src/models/cardanoStakingAccountModel';
import {
  baseAddress,
  decodeCardanoAddress
} from '../../../src/services/cardano/cardanoAddressService';
import {
  decideAutomaticAction,
  decideRequestedAction,
  type StakingDecisionContext
} from '../../../src/services/cardano/cardanoStakingPlanService';
import type { CardanoStakingProtocolParameters } from '../../../src/services/cardano/cardanoStakingProviderService';
import { stakingConfigFixture } from '../../helpers/stakingConfigFixture';

const POOL = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';
const OTHER_POOL = 'pool190dapqls3y9dxuqtexmm80sppjha7e8rhu62xydgwn4jjj07pqm';
const DREP = 'drep1ytcw6qzpqqclx2yd0zy64ztvlkkhnf6yrzza8whgnq4vz5gh89626';

const ADDRESS =
  decodeCardanoAddress(
    baseAddress(
      '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636',
      '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18',
      'testnet'
    )
  )?.payload ?? new Uint8Array();

/** Protocol parameters as Preprod reported them. */
const PARAMETERS: CardanoStakingProtocolParameters = {
  minFeeA: 44,
  minFeeB: 155_381,
  coinsPerUtxoByte: 4_310n,
  maxTxSize: 16_384,
  stakeAddressDeposit: 2_000_000n,
  drepDeposit: 500_000_000n
};

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
 * @param overrides - Anything else that differs.
 * @returns A stand-in for the account.
 */
function account(
  onChain: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {}
): ICardanoStakingAccount {
  return {
    _id: new Types.ObjectId(),
    preference: { enabled: true, version: 1, updatedAt: new Date() },
    termsConsent: { version: 'v1', acceptedAt: new Date(), source: 'web' },
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

/** A wallet that was already staking before ChatterPay looked, as the live chain has it. */
const ALREADY_STAKING = {
  registered: true,
  poolId: POOL,
  registrationOrigin: 'external' as const,
  depositLovelace: '2000000',
  governanceDelegation: { kind: 'drep' as const, idCip129: DREP },
  withdrawableRewardsLovelace: '8183734'
};

describe('cardanoStakingPlanService', () => {
  describe('nothing is decided on an unknown', () => {
    it('refuses every automatic action before a confirmed read', () => {
      // `asOf: null` is not "not registered" and not "no rewards". It is unknown, and an economic
      // decision taken on it is taken on a default that happens to look like a fact.
      const decision = decideAutomaticAction(account({ asOf: null }), context());

      expect(decision.action).toBe('none');
      expect(decision.refusal).toBe('no_confirmed_chain_read');
    });

    it('refuses a requested exit before a confirmed read, too', () => {
      const decision = decideRequestedAction(
        account({ ...ALREADY_STAKING, asOf: null }),
        'exit_and_send_max',
        context()
      );

      expect(decision.refusal).toBe('no_confirmed_chain_read');
    });

    it('refuses anything while an operation is in flight', () => {
      const decision = decideAutomaticAction(
        account(ALREADY_STAKING),
        context({ operationInFlight: true })
      );

      expect(decision.refusal).toBe('operation_in_flight');
    });
  });

  describe('a wallet that is already registered', () => {
    it('is never registered again', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING),
        'register_and_delegate',
        context()
      );

      expect(decision.action).toBe('none');
      expect(decision.refusal).toBe('already_registered');
    });

    it('is not registered again by the sweep either, however much ada it holds', () => {
      const decision = decideAutomaticAction(
        account(ALREADY_STAKING),
        context({ spendableLovelace: 1_000_000_000n })
      );

      expect(decision.action).not.toBe('register_and_delegate');
    });

    it('is offered its rewards like any other, whoever registered it', () => {
      // The origin decides what this service may claim to have done, not what the user may do.
      const decision = decideAutomaticAction(account(ALREADY_STAKING), context());

      expect(decision.action).toBe('withdraw_rewards');
    });

    it('can exit on the deposit somebody else paid, once that figure is known', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING),
        'exit_and_send_max',
        context()
      );

      expect(decision.action).toBe('exit_and_send_max');
    });

    it('cannot exit while the deposit it would refund is unknown', () => {
      // A deregistration built on a guessed refund does not balance, and the ledger refuses it
      // after a sponsor fee has already been spent finding out.
      const decision = decideRequestedAction(
        account({ ...ALREADY_STAKING, depositLovelace: null }),
        'exit_and_send_max',
        context()
      );

      expect(decision.action).toBe('none');
      expect(decision.refusal).toBe('deposit_unknown');
    });
  });

  describe('the Conway rule that reorders everything', () => {
    it('delegates the vote before withdrawing, for a credential that never has', () => {
      // `none` is a real state: registered, delegated to a pool, and never having delegated a vote.
      // Conway refuses a withdrawal from such a credential outright, so the withdrawal that the
      // rewards call for cannot be the next step.
      const decision = decideAutomaticAction(
        account({
          registered: true,
          poolId: POOL,
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: '8183734'
        }),
        context()
      );

      expect(decision.action).toBe('delegate_vote');
    });

    it('says so plainly when a user asks to withdraw', () => {
      // Not "no rewards": the user has rewards, and what stands between them and the money is a
      // vote delegation nobody mentioned.
      const decision = decideRequestedAction(
        account({
          registered: true,
          poolId: POOL,
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: '8183734'
        }),
        'withdraw_rewards',
        context()
      );

      expect(decision.refusal).toBe('vote_delegation_required');
    });

    it('withdraws once the vote is delegated, abstaining included', () => {
      // Abstaining is a delegation. It is what the ledger asks for, and it leaves the user's voice
      // uncommitted, which is why it is the default on first activation.
      const decision = decideAutomaticAction(
        account({
          registered: true,
          poolId: POOL,
          governanceDelegation: { kind: 'always_abstain' },
          withdrawableRewardsLovelace: '8183734'
        }),
        context()
      );

      expect(decision.action).toBe('withdraw_rewards');
    });

    it('treats a snapshot with no delegation field at all the same way', () => {
      const decision = decideAutomaticAction(
        account({ registered: true, poolId: POOL, governanceDelegation: null }),
        context()
      );

      expect(decision.action).toBe('delegate_vote');
    });
  });

  describe('the governance surface, as the network document configures it', () => {
    it('is not offered to a user when the network has it switched off', () => {
      const decision = decideRequestedAction(
        account({ registered: true, poolId: POOL, governanceDelegation: { kind: 'none' } }),
        'delegate_vote',
        context({ config: config({ governanceEnabled: false }) })
      );

      expect(decision).toMatchObject({ refusal: 'not_available', detail: 'governance' });
    });

    it('is offered again when the same document switches it on', () => {
      const decision = decideRequestedAction(
        account({ registered: true, poolId: POOL, governanceDelegation: { kind: 'none' } }),
        'delegate_vote',
        context({ config: config({ governanceEnabled: true }) })
      );

      expect(decision.action).toBe('delegate_vote');
    });

    it('still delegates the vote automatically when a withdrawal depends on it', () => {
      // Conway refuses a withdrawal from a credential that has not delegated its voting power, so
      // this one is not the governance feature being offered — it is the rewards being reachable.
      const decision = decideAutomaticAction(
        account({
          registered: true,
          poolId: POOL,
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: '8183734'
        }),
        context({ config: config({ governanceEnabled: false }) })
      );

      expect(decision.action).toBe('delegate_vote');
    });
  });

  describe('a pool that stops paying', () => {
    it('moves the delegation when a retirement is on record', () => {
      const decision = decideAutomaticAction(
        account(ALREADY_STAKING),
        context({
          poolState: {
            poolId: POOL,
            retirementScheduled: true,
            retiringEpoch: null,
            activeStakeLovelace: 0n
          }
        })
      );

      expect(decision.action).toBe('redelegate_pool');
    });

    it('moves it before withdrawing, because the rewards stop either way', () => {
      const decision = decideAutomaticAction(
        account({ ...ALREADY_STAKING, withdrawableRewardsLovelace: '8183734' }),
        context({
          poolState: {
            poolId: POOL,
            retirementScheduled: true,
            retiringEpoch: 318,
            activeStakeLovelace: 0n
          }
        })
      );

      expect(decision.action).toBe('redelegate_pool');
    });

    it('delegates a registered credential that points at no pool at all', () => {
      const decision = decideAutomaticAction(
        account({ ...ALREADY_STAKING, poolId: null }),
        context()
      );

      expect(decision.action).toBe('redelegate_pool');
    });

    it('refuses a redelegation to the pool it already uses', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING),
        'redelegate_pool',
        context()
      );

      expect(decision.refusal).toBe('already_delegated');
    });

    it('allows one away from a pool that is retiring, even to the configured default', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING),
        'redelegate_pool',
        context({
          poolState: {
            poolId: POOL,
            retirementScheduled: true,
            retiringEpoch: null,
            activeStakeLovelace: 0n
          }
        })
      );

      expect(decision.action).toBe('redelegate_pool');
    });

    it('allows one from a different pool to the configured default', () => {
      const decision = decideRequestedAction(
        account({ ...ALREADY_STAKING, poolId: OTHER_POOL }),
        'redelegate_pool',
        context()
      );

      expect(decision.action).toBe('redelegate_pool');
    });
  });

  describe('enrolling a wallet that is not registered', () => {
    it('registers one that clears the threshold', () => {
      const decision = decideAutomaticAction(account(), context());

      expect(decision.action).toBe('register_and_delegate');
    });

    it('leaves one below the configured threshold alone, and says which bar it missed', () => {
      // 4.5 ada clears the chain's floor of ~3.97 and misses the configured 5. The distinction is
      // worth carrying: this wallet *could* be enrolled, and this deployment has chosen not to.
      const decision = decideAutomaticAction(account(), context({ spendableLovelace: 4_500_000n }));

      expect(decision.action).toBe('none');
      expect(decision.refusal).toBe('not_eligible');
      expect(decision.detail).toBe('below_threshold');
    });

    it('distinguishes one that cannot be enrolled at all', () => {
      // Below the chain's own floor: not a preference, an impossibility. Three ada cannot cover a
      // two-ada deposit and still leave an output that exists.
      const decision = decideAutomaticAction(account(), context({ spendableLovelace: 3_000_000n }));

      expect(decision.refusal).toBe('not_eligible');
      expect(decision.detail).toBe('below_chain_floor');
    });

    it('confines enrolment to the wallets it was told to touch', () => {
      const allowed = account({}, { walletAddress: 'addr_test1_allowed' });
      const other = account({}, { walletAddress: 'addr_test1_other' });
      const confined = context({
        config: config({ enrolmentAllowlist: ['addr_test1_allowed'] })
      });

      expect(decideAutomaticAction(allowed, confined).action).toBe('register_and_delegate');
      expect(decideAutomaticAction(other, confined).refusal).toBe('not_allowlisted');
    });

    it('confines a user who asks as well as the sweep', () => {
      // A rollout limited to a handful of test wallets that anybody could opt into by pressing a
      // button is not limited.
      const other = account({}, { walletAddress: 'addr_test1_other' });

      const decision = decideRequestedAction(
        other,
        'register_and_delegate',
        context({ config: config({ enrolmentAllowlist: ['addr_test1_allowed'] }) })
      );

      expect(decision.refusal).toBe('not_allowlisted');
    });

    it('reads a list that is present and empty as nobody', () => {
      // Not the same as absent. A stray comma in the setting must not open the sweep to every
      // wallet in the database.
      const decision = decideAutomaticAction(
        account({}, { walletAddress: 'addr_test1_allowed' }),
        context({ config: config({ enrolmentAllowlist: [] }) })
      );

      expect(decision.refusal).toBe('not_allowlisted');
    });

    it('never confines an exit, a withdrawal or a redelegation', () => {
      // The confinement is about who gets registered. A user's own ada must not sit behind a
      // rollout setting, and an account that is already registered has to be able to leave.
      const confined = context({ config: config({ enrolmentAllowlist: ['somebody-else'] }) });
      const staking = account(ALREADY_STAKING, { walletAddress: 'addr_test1_other' });

      expect(decideRequestedAction(staking, 'exit_and_send_max', confined).action).toBe(
        'exit_and_send_max'
      );
      expect(decideRequestedAction(staking, 'withdraw_rewards', confined).action).toBe(
        'withdraw_rewards'
      );
      expect(decideRequestedAction(staking, 'deregister', confined).action).toBe('deregister');
    });

    it('does nothing at all while no pool is configured', () => {
      const decision = decideAutomaticAction(
        account(),
        context({ config: config({ defaultPoolId: null }) })
      );

      expect(decision.refusal).toBe('no_pool_configured');
    });
  });

  describe('consent, and the one thing it does not gate', () => {
    it('holds back an automatic registration without it', () => {
      const decision = decideAutomaticAction(account({}, { termsConsent: null }), context());

      expect(decision.refusal).toBe('no_terms_consent');
    });

    it('holds back a withdrawal without it', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING, { termsConsent: null }),
        'withdraw_rewards',
        context()
      );

      expect(decision.refusal).toBe('no_terms_consent');
    });

    it('lets a user leave without it', () => {
      // A user must be able to get their own ada out regardless of what they did or did not accept
      // on the way in — including every wallet that was staking before this service existed.
      const decision = decideRequestedAction(
        account(ALREADY_STAKING, { termsConsent: null }),
        'exit_and_send_max',
        context()
      );

      expect(decision.action).toBe('exit_and_send_max');
    });

    it('lets a user deregister without it', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING, {
          termsConsent: null,
          preference: { enabled: false, version: 1 }
        }),
        'deregister',
        context()
      );

      expect(decision.action).toBe('deregister');
    });

    it('holds back the sweep for a user who has not opted in', () => {
      const decision = decideAutomaticAction(
        account(ALREADY_STAKING, { preference: { enabled: false, version: 1 } }),
        context()
      );

      expect(decision.refusal).toBe('not_opted_in');
    });
  });

  describe('what is deliberately not available', () => {
    it('refuses the DRep-of-our-own kinds while the flag is off', () => {
      for (const kind of ['register_drep', 'update_drep', 'cast_drep_vote'] as const) {
        const decision = decideRequestedAction(account(ALREADY_STAKING), kind, context());

        expect(decision.action).toBe('none');
        expect(decision.refusal).toBe('not_available');
      }
    });

    it('refuses everything while staking is switched off', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING),
        'withdraw_rewards',
        context({ config: config({ enabled: false, disabledReason: 'flag_off' }) })
      );

      expect(decision.refusal).toBe('staking_disabled');
      expect(decision.detail).toBe('flag_off');
    });
  });

  describe('when there is simply nothing to do', () => {
    it('answers none without a refusal for a healthy, settled account', () => {
      const decision = decideAutomaticAction(
        account({ ...ALREADY_STAKING, withdrawableRewardsLovelace: '0' }),
        context()
      );

      expect(decision.action).toBe('none');
      expect(decision.refusal).toBeNull();
    });

    it('refuses a withdrawal of nothing', () => {
      const decision = decideRequestedAction(
        account({ ...ALREADY_STAKING, withdrawableRewardsLovelace: '0' }),
        'withdraw_rewards',
        context()
      );

      expect(decision.refusal).toBe('no_rewards');
    });

    it('refuses to withdraw from a credential that is not registered', () => {
      const decision = decideRequestedAction(account(), 'withdraw_rewards', context());

      expect(decision.refusal).toBe('not_registered');
    });
  });

  describe('signer availability', () => {
    it('refuses the sweep for a credential this deployment cannot witness', () => {
      const decision = decideAutomaticAction(
        account(ALREADY_STAKING),
        context({ signerAvailable: false })
      );

      expect(decision.refusal).toBe('signer_unavailable');
    });

    it('refuses a requested action for a credential this deployment cannot witness', () => {
      const decision = decideRequestedAction(
        account(ALREADY_STAKING),
        'withdraw_rewards',
        context({ signerAvailable: false })
      );

      expect(decision.refusal).toBe('signer_unavailable');
    });

    it('refuses an exit for a wallet nobody here holds the keys to', () => {
      // The one action that is otherwise always permitted. The protocol would accept it; this
      // deployment cannot produce it, and saying so is the whole point.
      const decision = decideRequestedAction(
        account({ ...ALREADY_STAKING, depositLovelace: '2000000' }),
        'exit_and_send_max',
        context({ signerAvailable: false })
      );

      expect(decision.refusal).toBe('signer_unavailable');
    });

    it('reports the missing signer ahead of the missing snapshot', () => {
      // Both are true. The signer is the one that no further reading can change.
      const decision = decideAutomaticAction(
        account({ asOf: null }),
        context({ signerAvailable: false })
      );

      expect(decision.refusal).toBe('signer_unavailable');
    });
  });

  describe('what the sweep may start on its own', () => {
    const OUTSIDE = config({ enrolmentAllowlist: ['addr_test1_somebody_else'] });

    it('does not delegate a vote for an account outside the confinement', () => {
      const decision = decideAutomaticAction(
        account({ ...ALREADY_STAKING, governanceDelegation: { kind: 'none' } }),
        context({ config: OUTSIDE })
      );

      expect(decision).toMatchObject({ refusal: 'not_allowlisted', detail: 'delegate_vote' });
    });

    it('delegates a vote for an account ChatterPay itself registered', () => {
      // Dropped from the list after being enrolled. It is a commitment now, not a candidate.
      const decision = decideAutomaticAction(
        account({
          ...ALREADY_STAKING,
          governanceDelegation: { kind: 'none' },
          registrationOrigin: 'chatterpay'
        }),
        context({ config: OUTSIDE })
      );

      expect(decision.action).toBe('delegate_vote');
    });

    it('still withdraws rewards for an account outside the confinement', () => {
      // A rollout setting has no business standing between a user and their own ada.
      const decision = decideAutomaticAction(
        account({
          ...ALREADY_STAKING,
          governanceDelegation: { kind: 'always_abstain' },
          withdrawableRewardsLovelace: '8183734'
        }),
        context({ config: OUTSIDE })
      );

      expect(decision.action).toBe('withdraw_rewards');
    });

    it('does not move a retiring pool for an account outside the confinement', () => {
      const decision = decideAutomaticAction(
        account({ ...ALREADY_STAKING, governanceDelegation: { kind: 'always_abstain' } }),
        context({
          config: OUTSIDE,
          poolState: {
            poolId: POOL,
            retirementScheduled: true,
            retiringEpoch: 320,
            activeStakeLovelace: null
          }
        })
      );

      expect(decision).toMatchObject({ refusal: 'not_allowlisted', detail: 'redelegate_pool' });
    });
  });

  describe('leaving with rewards on the account', () => {
    it('refuses an exit that would have to withdraw without a vote delegation', () => {
      // The ledger will not deregister a credential whose reward account holds something, and Conway
      // will not let that credential withdraw. Offering the exit anyway produces a rejected node call.
      const decision = decideRequestedAction(
        account({
          ...ALREADY_STAKING,
          depositLovelace: '2000000',
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: '8183734'
        }),
        'exit_and_send_max',
        context()
      );

      expect(decision.refusal).toBe('vote_delegation_required');
    });

    it('allows an exit with an empty reward account and no vote delegation', () => {
      const decision = decideRequestedAction(
        account({
          ...ALREADY_STAKING,
          depositLovelace: '2000000',
          governanceDelegation: { kind: 'none' },
          withdrawableRewardsLovelace: '0'
        }),
        'exit_and_send_max',
        context()
      );

      expect(decision.action).toBe('exit_and_send_max');
    });
  });
});
