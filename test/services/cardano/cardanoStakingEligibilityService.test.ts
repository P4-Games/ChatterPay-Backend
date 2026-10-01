import { describe, expect, it } from 'vitest';

import type { CardanoStakingConfig } from '../../../src/config/cardanoStakingConfig';
import {
  baseAddress,
  decodeCardanoAddress
} from '../../../src/services/cardano/cardanoAddressService';
import {
  assessStakingEnrolment,
  stakingChainFloorLovelace,
  stakingEnrolmentReadiness
} from '../../../src/services/cardano/cardanoStakingEligibilityService';
import type { CardanoStakingProtocolParameters } from '../../../src/services/cardano/cardanoStakingProviderService';
import { stakingConfigFixture } from '../../helpers/stakingConfigFixture';

const PAYMENT = '0x7c3ca0ade35d250f5706a17cbbc9e97402b5c230b26b24b940c77e4c00154636';
const STAKE = '0xce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed17673ed50d18';

const ADDRESS =
  decodeCardanoAddress(baseAddress(PAYMENT, STAKE, 'testnet'))?.payload ?? new Uint8Array();

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
  return stakingConfigFixture({ termsVersion: 'v1', consentRequired: true, ...overrides });
}

describe('cardanoStakingEligibilityService', () => {
  describe('the floor the chain imposes', () => {
    it('is the deposit, a surviving output and room to still afford something', () => {
      const floor = stakingChainFloorLovelace(PARAMETERS, ADDRESS);

      // Above the deposit alone: a wallet that spends everything on the deposit has nothing left to
      // carry an output, and an output that cannot exist is a transaction the ledger refuses.
      expect(floor).toBeGreaterThan(PARAMETERS.stakeAddressDeposit);
      expect(floor).toBeLessThan(5_000_000n);
    });

    it('moves with the deposit rather than staying where it was written', () => {
      // The deposit is governable. A floor that did not follow it would go on admitting wallets
      // that can no longer pay, and the refusal would arrive after a sponsor fee was spent.
      const raised = stakingChainFloorLovelace(
        { ...PARAMETERS, stakeAddressDeposit: 4_000_000n },
        ADDRESS
      );

      expect(raised - stakingChainFloorLovelace(PARAMETERS, ADDRESS)).toBe(2_000_000n);
    });

    it('moves with the cost of keeping an output alive', () => {
      const dearer = stakingChainFloorLovelace(
        { ...PARAMETERS, coinsPerUtxoByte: 8_620n },
        ADDRESS
      );

      expect(dearer).toBeGreaterThan(stakingChainFloorLovelace(PARAMETERS, ADDRESS));
    });
  });

  describe('the configured threshold against that floor', () => {
    it('lets a threshold above the floor stand exactly as configured', () => {
      const readiness = stakingEnrolmentReadiness(config(), PARAMETERS, ADDRESS);

      expect(readiness.allowed).toBe(true);
      expect(readiness.effectiveThresholdLovelace).toBe(5_000_000n);
      // The starting value is a product decision, not the chain's floor, and they are not equal.
      expect(readiness.effectiveThresholdLovelace).not.toBe(readiness.chainFloorLovelace);
    });

    it('stops automatic enrolment rather than quietly raising a threshold below the floor', () => {
      // Substituting the floor would enrol wallets somebody meant to exclude, while looking from
      // the outside as though the configuration were being honoured.
      const readiness = stakingEnrolmentReadiness(
        config({ minimumEnrolmentLovelace: 1_000_000n }),
        PARAMETERS,
        ADDRESS
      );

      expect(readiness.allowed).toBe(false);
      expect(readiness.refusal).toBe('threshold_below_chain_floor');
      // Both numbers are reported, so whoever reads it can see which one has to change.
      expect(readiness.configuredThresholdLovelace).toBe(1_000_000n);
      expect(readiness.chainFloorLovelace).toBeGreaterThan(1_000_000n);
    });

    it('catches a threshold that was fine until the deposit rose', () => {
      // The same five ada that cleared a two-ada deposit does not clear a five-ada one.
      const readiness = stakingEnrolmentReadiness(
        config(),
        { ...PARAMETERS, stakeAddressDeposit: 5_000_000n },
        ADDRESS
      );

      expect(readiness.allowed).toBe(false);
      expect(readiness.refusal).toBe('threshold_below_chain_floor');
    });

    it('refuses when staking is switched off, whatever the numbers say', () => {
      const readiness = stakingEnrolmentReadiness(
        config({ enabled: false, disabledReason: 'flag_off' }),
        PARAMETERS,
        ADDRESS
      );

      expect(readiness.allowed).toBe(false);
      expect(readiness.refusal).toBe('staking_disabled');
    });
  });

  describe('one wallet against the bar', () => {
    it('admits a wallet above the configured threshold', () => {
      const assessment = assessStakingEnrolment(config(), PARAMETERS, ADDRESS, 10_000_000n);

      expect(assessment.eligible).toBe(true);
      expect(assessment.refusal).toBeNull();
    });

    it('turns a wallet away below the threshold but above the floor', () => {
      // A product decision, and it says so: the wallet could be enrolled, and this deployment has
      // chosen not to.
      const assessment = assessStakingEnrolment(config(), PARAMETERS, ADDRESS, 4_000_000n);

      expect(assessment.eligible).toBe(false);
      expect(assessment.refusal).toBe('below_threshold');
      expect(assessment.readiness.chainFloorLovelace).toBeLessThan(4_000_000n);
    });

    it('turns a wallet away below the floor for a different reason', () => {
      // Not a preference. This wallet cannot complete an enrolment at all.
      const assessment = assessStakingEnrolment(config(), PARAMETERS, ADDRESS, 2_000_000n);

      expect(assessment.eligible).toBe(false);
      expect(assessment.refusal).toBe('below_chain_floor');
    });

    it('admits a wallet at exactly the threshold', () => {
      const assessment = assessStakingEnrolment(config(), PARAMETERS, ADDRESS, 5_000_000n);

      expect(assessment.eligible).toBe(true);
    });

    it('never admits a wallet while the threshold is below the floor', () => {
      // Even a rich wallet: the misconfiguration is about the deployment, not about this user, and
      // running the sweep on a threshold nobody validated is what the refusal exists to stop.
      const assessment = assessStakingEnrolment(
        config({ minimumEnrolmentLovelace: 1n }),
        PARAMETERS,
        ADDRESS,
        1_000_000_000n
      );

      expect(assessment.eligible).toBe(false);
      expect(assessment.refusal).toBe('threshold_below_chain_floor');
    });
  });
});
