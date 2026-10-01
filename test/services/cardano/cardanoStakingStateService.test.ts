import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { ICardanoStakingAccount } from '../../../src/models/cardanoStakingAccountModel';
import { deriveStakingAccountState } from '../../../src/services/cardano/cardanoStakingStateService';

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
    termsConsent: { version: 'dev-v1', acceptedAt: new Date(), source: 'web' },
    state: 'awaiting_consent',
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

describe('deriveStakingAccountState', () => {
  it('reports a registered credential as active', () => {
    // The case that used to be wrong: a wallet registered and delegated, still reading
    // `awaiting_consent` because nothing moved it.
    expect(deriveStakingAccountState(account({ registered: true }), null)).toBe('active');
  });

  it('asks for consent before anything else', () => {
    expect(deriveStakingAccountState(account({}, { termsConsent: null }), null)).toBe(
      'awaiting_consent'
    );
  });

  it('asks for consent when the user has not switched staking on', () => {
    const off = account({}, { preference: { enabled: false, version: 1, updatedAt: new Date() } });

    expect(deriveStakingAccountState(off, null)).toBe('awaiting_consent');
  });

  it('waits for funds once consent and opt-in are in place', () => {
    expect(deriveStakingAccountState(account(), null, 'insufficient')).toBe('awaiting_funds');
  });

  it('is ready to activate when the wallet clears the bar', () => {
    expect(deriveStakingAccountState(account(), null, 'sufficient')).toBe('activation_pending');
  });

  it('asks for a reconciliation when the credential has never been read', () => {
    // Not `awaiting_funds`: there is no basis for saying anything about the funds, which is the same
    // reason the sweep refuses to act on it.
    expect(deriveStakingAccountState(account({ asOf: null }), null)).toBe('reconcile_required');
  });

  it('reports a registration being prepared', () => {
    const live = { kind: 'register_and_delegate' as const, status: 'queued' as const };

    expect(deriveStakingAccountState(account(), live)).toBe('activation_pending');
  });

  it('reports a registration that is signed but not yet sent', () => {
    const live = { kind: 'register_and_delegate' as const, status: 'signed' as const };

    expect(deriveStakingAccountState(account(), live)).toBe('signing');
  });

  it('reports a registration that is out of our hands', () => {
    const live = { kind: 'register_and_delegate' as const, status: 'submitted' as const };

    expect(deriveStakingAccountState(account(), live)).toBe('submitted');
  });

  it('treats an unresolved submit the same as a submit', () => {
    // `unknown_submit` means the transaction may be on chain. Reading it as "nothing happened" is the
    // one interpretation that is unsafe.
    const live = { kind: 'register_and_delegate' as const, status: 'unknown_submit' as const };

    expect(deriveStakingAccountState(account(), live)).toBe('submitted');
  });

  it('stays active while something else is done to a live position', () => {
    // A vote delegation or a withdrawal operates on the position; it does not suspend it.
    const live = { kind: 'withdraw_rewards' as const, status: 'submitted' as const };

    expect(deriveStakingAccountState(account({ registered: true }), live)).toBe('active');
  });

  it('reports an exit being prepared', () => {
    const live = { kind: 'exit_and_send_max' as const, status: 'queued' as const };

    expect(deriveStakingAccountState(account({ registered: true }), live)).toBe('exit_pending');
  });

  it('reports an exit that is out of our hands', () => {
    const live = { kind: 'deregister' as const, status: 'submitted' as const };

    expect(deriveStakingAccountState(account({ registered: true }), live)).toBe('exit_submitted');
  });

  it('shows the exit rather than the position it is unwinding', () => {
    // The credential is still registered and still earning at this moment. The user asked to leave;
    // answering "active" answers a question they did not ask.
    const live = { kind: 'exit_and_send_max' as const, status: 'submitted' as const };

    expect(deriveStakingAccountState(account({ registered: true }), live)).not.toBe('active');
  });

  it('keeps a wallet on its way out reported as active', () => {
    // It is registered and it is earning until the deregistration lands. The screen distinguishes this
    // from a wallet that is simply staking through the opt-out record the view carries, not through a
    // state value that would have to encode both facts at once.
    const leaving = account(
      { registered: true },
      { optOut: { at: new Date(), reason: 'user_exit', source: 'web', preferenceVersion: 1 } }
    );

    expect(deriveStakingAccountState(leaving, null)).toBe('active');
  });

  it('reports a wallet that finished leaving as waiting for a fresh opt-in', () => {
    // Accurate rather than a gap: a fresh opt-in is exactly what it is waiting for, and the only thing
    // that puts it back.
    const left = account(
      { registered: false },
      {
        preference: { enabled: false, version: 2, updatedAt: new Date() },
        optOut: { at: new Date(), reason: 'user_exit', source: 'web', preferenceVersion: 1 }
      }
    );

    expect(deriveStakingAccountState(left, null)).toBe('awaiting_consent');
  });

  it('puts manual review above everything', () => {
    const live = { kind: 'register_and_delegate' as const, status: 'manual_review' as const };

    expect(deriveStakingAccountState(account({ registered: true }), live)).toBe('manual_review');
  });
});
