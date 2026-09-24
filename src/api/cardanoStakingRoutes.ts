import type { FastifyInstance } from 'fastify';

import { cardanoStakingSync } from '../controllers/cardanoStakingSyncController';

/**
 * The Cardano staking routes.
 *
 * One route for now, and it is the machine-to-machine one. `/internal/` is not a convention this
 * repository had before: it marks a path that no browser reaches, that is exempt from the `Origin`
 * check, and that authenticates a Google OIDC identity instead. Anything a *user* asks for goes
 * through the existing session and PIN mechanisms on the routes they already use.
 *
 * The schedule that calls this is configured in GCP, outside this repository. Nothing here creates,
 * deploys or assumes a scheduler; the endpoint answers whoever presents an accepted identity.
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
};
