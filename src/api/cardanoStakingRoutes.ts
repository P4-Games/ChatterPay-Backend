import type { FastifyInstance } from 'fastify';

import {
  cardanoGovernanceHistory,
  cardanoGovernanceOptions,
  cardanoStakingAction,
  cardanoStakingAuthorize,
  cardanoStakingConsent,
  cardanoStakingExitQuote,
  cardanoStakingState,
  cardanoStakingSummary
} from '../controllers/cardanoStakingController';
import { cardanoStakingSync } from '../controllers/cardanoStakingSyncController';

/**
 * The Cardano staking routes.
 *
 * Two kinds, authenticated two different ways, and the split is the point.
 *
 * `/internal/` is a convention this repository did not have before: a path no browser reaches, exempt
 * from the `Origin` check and carrying a credential of its own rather than the shared product token.
 * The schedule that calls it is configured in GCP, outside this repository — nothing here creates,
 * deploys or assumes a scheduler; the endpoint answers whoever presents that one secret.
 *
 * The rest are the user-facing ones, and they use what the product already uses: the internal token
 * from a Next.js route that resolved the session itself. None of them takes a wallet. Every one takes
 * a `channel_user_id` and the service resolves the credential from it, so a request cannot be aimed
 * at somebody else's position.
 *
 * @param fastify - Fastify instance.
 */
export const cardanoStakingRoutes = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Runs one staking sync pass.
   *
   * @route POST /internal/cardano/staking/sync
   */
  fastify.post('/internal/cardano/staking/sync', cardanoStakingSync);

  /**
   * The staking position of the authenticated user's own wallet.
   *
   * @route GET /cardano/staking/state?channel_user_id=<id>
   */
  fastify.get('/cardano/staking/state', cardanoStakingState);

  /**
   * Records the terms acceptance and the opt-in, together.
   *
   * @route POST /cardano/staking/consent
   */
  fastify.post('/cardano/staking/consent', cardanoStakingConsent);

  /**
   * The position as a conversational channel needs it: figures and facts, no controls.
   *
   * @route GET /cardano/staking/summary?channel_user_id=<id>
   */
  fastify.get('/cardano/staking/summary', cardanoStakingSummary);

  /**
   * What sending everything would move: gross, fees, refund and net.
   *
   * @route GET /cardano/staking/exit-quote?channel_user_id=<id>&recipient_address=<addr>
   */
  fastify.get('/cardano/staking/exit-quote', cardanoStakingExitQuote);

  /**
   * Verifies the PIN for one action and issues a grant bound to it.
   *
   * @route POST /cardano/staking/authorize
   */
  fastify.post('/cardano/staking/authorize', cardanoStakingAuthorize);

  /**
   * Takes an action on the authenticated user's own position.
   *
   * @route POST /cardano/staking/action
   */
  fastify.post('/cardano/staking/action', cardanoStakingAction);

  /**
   * What a vote may be delegated to. Read-only; nothing here registers a DRep or casts a vote.
   *
   * @route GET /cardano/governance/options
   */
  fastify.get('/cardano/governance/options', cardanoGovernanceOptions);

  /**
   * The governance history of the authenticated user's own credential.
   *
   * @route GET /cardano/governance/history?channel_user_id=<id>
   */
  fastify.get('/cardano/governance/history', cardanoGovernanceHistory);
};
