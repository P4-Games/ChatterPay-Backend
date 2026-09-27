/**
 * Whether this deployment's Cardano keys have been shown to be the ones it issued before.
 *
 * Held here, in a module of its own, for two reasons. The derivation check needs the resolved
 * configuration to know which network and chain id to derive against, and the configuration needs
 * the check's verdict to decide whether the family is available — importing one from the other
 * would close that loop. And the verdict is process state rather than a setting: it is decided once
 * at startup, and nothing a request does may change it.
 *
 * The starting state is `pending`, which reads as *not verified* everywhere it is consulted. That
 * is the whole safety property: a deployment that fails before the check runs, or that never calls
 * it, keeps Cardano off rather than inheriting the answer the check would have given.
 */

import type { CardanoDerivationScope, CardanoDisabledReason } from '../types/cardanoType';

/**
 * What is known about this deployment's derivation.
 *
 * - `pending` — the check has not run. Not an answer, and never treated as one.
 * - `verified` — every reference this deployment needs was compared and matched.
 * - `unrecorded` — nothing to compare a derivation against, so nothing is known about it.
 * - `changed` — a derivation no longer produces the address that was recorded for it.
 */
export type CardanoDerivationState =
  | { status: 'pending' }
  | { status: 'verified' }
  | { status: 'unrecorded'; scope: CardanoDerivationScope }
  | { status: 'changed'; scope: CardanoDerivationScope };

/** The verdict, until the check replaces it. */
let state: CardanoDerivationState = { status: 'pending' };

/**
 * What the check concluded, so far.
 *
 * @returns The current state.
 */
export function getCardanoDerivationState(): CardanoDerivationState {
  return state;
}

/**
 * Records what the check concluded.
 *
 * Called by the startup check and by nothing else. No request path reaches this, which is what
 * keeps a caller from promoting the deployment to `verified` by asking.
 *
 * @param next - The verdict.
 */
export function recordCardanoDerivationState(next: CardanoDerivationState): void {
  state = next;
}

/**
 * Puts the verdict back to `pending`.
 *
 * For fixtures and tests, which need to drive a process through several verdicts. Production code
 * records a verdict once and never rewinds it.
 */
export function resetCardanoDerivationState(): void {
  state = { status: 'pending' };
}

/**
 * Why the derivation state keeps the family off, if it does.
 *
 * @returns The reason, or an empty string when the derivation is no obstacle.
 */
export function cardanoDerivationDisabledReason(): CardanoDisabledReason {
  switch (state.status) {
    case 'verified':
      return '';
    case 'unrecorded':
      return 'derivation_unrecorded';
    case 'changed':
      return 'derivation_changed';
    default:
      return 'derivation_unverified';
  }
}
