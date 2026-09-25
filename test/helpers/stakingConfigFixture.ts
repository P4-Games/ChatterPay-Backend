import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import type { CardanoStakingConfig } from '../../src/config/cardanoStakingConfig';

/**
 * A staking configuration as `loadCardanoStakingConfig` would return it.
 *
 * Shared because the settings now come from a network document rather than from the environment:
 * every field added to that document has to reach the suites that drive the services, and eight
 * private copies of the same literal is eight places to forget one.
 *
 * @param overrides - What differs for the case under test.
 * @returns The configuration.
 */
export function stakingConfigFixture(
  overrides: Partial<CardanoStakingConfig> = {}
): CardanoStakingConfig {
  return {
    enabled: true,
    disabledReason: '',
    chainId: CARDANO_PREPROD_CHAIN_ID,
    minimumEnrolmentLovelace: 5_000_000n,
    defaultPoolId: 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx',
    allowlistedPools: [],
    termsVersion: 'v1',
    consentRequired: false,
    feeDailyCapLovelace: 50_000_000n,
    drepOwnEnabled: false,
    governanceEnabled: true,
    allowlistedDReps: null,
    defaultGovernance: 'always_abstain',
    enrolmentAllowlist: null,
    maxSponsoredRegistrationsPerWindow: 2,
    sponsorWindowDays: 30,
    sweepExecutionEnabled: true,
    maxWalletsPerRun: 50,
    maxProviderRequestsPerRun: 1000,
    ...overrides
  };
}
