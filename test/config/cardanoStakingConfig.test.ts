import { beforeEach, describe, expect, it } from 'vitest';

import { CARDANO_PREPROD_CHAIN_ID } from '../../src/config/cardanoConfig';
import { loadCardanoStakingConfig } from '../../src/config/cardanoStakingConfig';
import Blockchain from '../../src/models/blockchainModel';
import { seedStakingNetwork, TEST_POOL_ID } from '../support/cardanoStakingNetwork';

/**
 * Where staking settings come from, and what happens when they are not there.
 *
 * The property being pinned is that the network's own document decides: the same process, with the
 * same environment, answers differently when the document changes. That is the whole reason the
 * settings moved out of the environment — one deployment can operate two Cardano networks, and a
 * process-wide variable cannot hold a pool for each.
 */

/** Another pool, to tell one configuration from the next. */
const OTHER_POOL = 'pool1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

describe('loadCardanoStakingConfig', () => {
  beforeEach(async () => {
    await Blockchain.deleteMany({});
  });

  it('reads the settings off the network document', async () => {
    await seedStakingNetwork({
      termsVersion: 'doc-v7',
      minimumUserAdaForEnrollmentLovelace: '7000000'
    });

    const config = await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID);

    expect(config.enabled).toBe(true);
    expect(config.chainId).toBe(CARDANO_PREPROD_CHAIN_ID);
    expect(config.defaultPoolId).toBe(TEST_POOL_ID);
    expect(config.termsVersion).toBe('doc-v7');
    expect(config.minimumEnrolmentLovelace).toBe(7_000_000n);
  });

  it('answers differently once the document changes', async () => {
    await seedStakingNetwork();
    const before = await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID);

    await Blockchain.updateOne(
      { chainId: CARDANO_PREPROD_CHAIN_ID },
      {
        $set: {
          'staking.defaultPoolId': OTHER_POOL,
          'staking.consentRequired': true,
          'staking.dailySponsorFeeBudgetLovelace': '1000000'
        }
      }
    );
    const after = await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID);

    // No restart, no cache to wait out: the next read sees what was written.
    expect(before.defaultPoolId).toBe(TEST_POOL_ID);
    expect(before.consentRequired).toBe(false);
    expect(after.defaultPoolId).toBe(OTHER_POOL);
    expect(after.consentRequired).toBe(true);
    expect(after.feeDailyCapLovelace).toBe(1_000_000n);
  });

  it('keeps two networks apart', async () => {
    const mainnet = 900764824073;
    await seedStakingNetwork({ defaultPoolId: TEST_POOL_ID });
    await seedStakingNetwork({ defaultPoolId: OTHER_POOL, enabled: false }, mainnet);

    expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).defaultPoolId).toBe(
      TEST_POOL_ID
    );
    expect((await loadCardanoStakingConfig(mainnet)).disabledReason).toBe('flag_off');
  });

  describe('fails closed', () => {
    it('when the network is not in the database', async () => {
      const config = await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID);

      expect(config.enabled).toBe(false);
      expect(config.disabledReason).toBe('settings_missing');
      expect(config.defaultPoolId).toBeNull();
      expect(config.minimumEnrolmentLovelace).toBe(0n);
    });

    it('when the network carries no staking section', async () => {
      await seedStakingNetwork();
      await Blockchain.updateOne(
        { chainId: CARDANO_PREPROD_CHAIN_ID },
        { $unset: { staking: '' } }
      );

      expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).disabledReason).toBe(
        'settings_missing'
      );
    });

    it('when nothing in the environment says otherwise', async () => {
      // The variables that used to carry this are gone. Setting them proves it: with no document,
      // the answer is still a refusal rather than a configuration assembled from the process.
      process.env.CARDANO_STAKING_ENABLED = 'true';
      process.env.CARDANO_STAKING_DEFAULT_POOL_ID = TEST_POOL_ID;

      const config = await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID);

      expect(config.enabled).toBe(false);
      expect(config.defaultPoolId).toBeNull();

      process.env.CARDANO_STAKING_ENABLED = undefined;
      process.env.CARDANO_STAKING_DEFAULT_POOL_ID = undefined;
    });

    it('when the default pool is not on the network allowlist', async () => {
      await seedStakingNetwork({
        defaultPoolId: TEST_POOL_ID,
        allowlistedPools: [{ poolId: OTHER_POOL, enabled: true }]
      });

      expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).disabledReason).toBe(
        'pool_not_allowlisted'
      );
    });

    it('when the allowlisted pool is listed but switched off', async () => {
      await seedStakingNetwork({
        defaultPoolId: TEST_POOL_ID,
        allowlistedPools: [{ poolId: TEST_POOL_ID, enabled: false }]
      });

      expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).disabledReason).toBe(
        'pool_not_allowlisted'
      );
    });

    it('when an amount is not a usable figure', async () => {
      await seedStakingNetwork();
      // Written through the driver: the schema would refuse this, and the point is what happens to
      // a document that got past it — by an older write, or by hand in a shell.
      await Blockchain.collection.updateOne(
        { chainId: CARDANO_PREPROD_CHAIN_ID },
        { $set: { 'staking.minimumUserAdaForEnrollmentLovelace': '5 ADA' } }
      );

      expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).disabledReason).toBe(
        'threshold_invalid'
      );
    });

    it('when there is no terms version to stamp a consent with', async () => {
      await seedStakingNetwork();
      await Blockchain.collection.updateOne(
        { chainId: CARDANO_PREPROD_CHAIN_ID },
        { $set: { 'staking.termsVersion': '  ' } }
      );

      expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).disabledReason).toBe(
        'terms_missing'
      );
    });
  });

  describe('the defaults a working network runs with', () => {
    it('stake automatically and keep the opt-out above everything', async () => {
      await seedStakingNetwork();

      const config = await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID);

      // Automatic: no consent gate, and no allowlist confining the sweep to a handful of wallets.
      expect(config.consentRequired).toBe(false);
      expect(config.enrolmentAllowlist).toBeNull();
      // The opt-out is not a setting at all, which is what makes it absolute: nothing here can turn
      // it off, and the sweep reads it from the account.
      expect(Object.keys(config)).not.toContain('optOut');
    });

    it('reads an allowlist as confinement only when it names somebody', async () => {
      await seedStakingNetwork({ enrolmentAllowlist: ['addr_test1qsomebody'] });

      expect((await loadCardanoStakingConfig(CARDANO_PREPROD_CHAIN_ID)).enrolmentAllowlist).toEqual(
        ['addr_test1qsomebody']
      );
    });
  });
});
