import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import Blockchain, { type CardanoStakingSettings } from '../../src/models/blockchainModel';

/**
 * The network document the staking settings are read from.
 *
 * Staking configuration lives in `blockchains.staking`, so a suite that drives a service
 * through its settings has to put a network in the database rather than set a variable. The
 * defaults here are the ones a working Preprod deployment runs with; a test that is about a setting
 * overrides that setting and nothing else.
 */

/** The pool used wherever a test needs a plausible one. */
export const TEST_POOL_ID = 'pool1vvkurfxhajtj4f7x8wjkeet7rg8amz34duy5nux76per5sn3npx';

/**
 * Writes a Cardano network with staking configured.
 *
 * @param overrides - Staking settings that differ from the working defaults.
 * @param chainId - The network to write. Defaults to Preprod.
 * @returns Nothing; the document is in the database when it resolves.
 */
export async function seedStakingNetwork(
  overrides: Partial<CardanoStakingSettings> = {},
  chainId: number = CARDANO_PREPROD_CHAIN_ID
): Promise<void> {
  await Blockchain.create({
    name: 'Cardano Preprod',
    family: 'cardano',
    chainId,
    explorer: 'https://preprod.cardanoscan.io/transaction/',
    environment: 'TEST',
    limits: { transfer: { L1: { D: 50 }, L2: { D: 1000 } } },
    network: 'testnet',
    providerUrl: 'https://preprod.koios.rest/api/v1',
    ttlSlots: 900,
    depositConfirmations: 3,
    staking: {
      enabled: true,
      financingMode: 'user_deposit_sponsor_fees',
      defaultPoolId: TEST_POOL_ID,
      allowlistedPools: [],
      defaultGovernance: 'always_abstain',
      termsVersion: 'dev-v1',
      consentRequired: false,
      enrolmentAllowlist: [],
      minimumUserAdaForEnrollmentLovelace: '5000000',
      sweepExecutionEnabled: true,
      maxWalletsPerRun: 50,
      maxProviderRequestsPerRun: 1000,
      maxSponsoredRegistrationsPerAccountRollingWindow: 2,
      sponsorRollingWindowDays: 30,
      dailySponsorFeeBudgetLovelace: '50000000',
      autoRedelegateRetiredPools: true,
      governanceEnabled: true,
      allowlistedDReps: [],
      drepOwnEnabled: false,
      ...overrides
    }
  });
}
