import type { CardanoEnv, CardanoFeeEnv } from '../../src/types/cardanoType';

/**
 * The Cardano settings, as the tests drive them.
 *
 * Held here rather than written onto the process environment: the environment is read in exactly
 * one place, so a test that wants a different configuration mocks what that place answers. Nothing
 * downstream has an opinion about where a value came from, which is the property that makes this
 * work — and it keeps the variable names, including the sensitive ones, out of test code.
 *
 * Each test file declares the mocks itself, because `vi.mock` resolves its path relative to the
 * file it appears in:
 *
 * ```ts
 * vi.mock('../../src/helpers/envHelper', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('../../src/helpers/envHelper')>();
 *   const { cardanoEnvHelperMock } = await import('../support/cardanoEnv');
 *   return cardanoEnvHelperMock(actual);
 * });
 * ```
 *
 * A suite that also derives addresses adds the second one, so the derivation answers to fixed
 * inputs rather than to whatever the machine running it has configured:
 *
 * ```ts
 * vi.mock('../../src/config/constants', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('../../src/config/constants')>();
 *   const { cardanoConstantsMock } = await import('../support/cardanoEnv');
 *   return cardanoConstantsMock(actual);
 * });
 * ```
 */
export interface CardanoEnvState {
  /** The address recorded for the startup check. */
  derivationCheck: string;
  /** Everything `getCardanoConfig` resolves from. */
  env: CardanoEnv;
  /** Everything `getCardanoFeeConfig` resolves from. */
  feeEnv: CardanoFeeEnv;
}

/** A configuration with nothing set: the shape a deployment has before anybody configures it. */
function blank(): CardanoEnvState {
  return {
    derivationCheck: '',
    env: {
      enabled: false,
      network: '',
      chainId: null,
      providerUrl: '',
      providerApiKey: '',
      providerTimeoutMs: null,
      ttlSlots: null,
      depositConfirmations: null,
      explorerUrl: '',
      hasSecret: true,
      labelsReadable: true
    },
    feeEnv: {
      sponsorFees: false,
      transferFeeUsd: null,
      transferFeeAda: null,
      transferFeeAdaNewOutput: null,
      feeScheme: null,
      recycleDestinationUtxo: false,
      routeDustToSponsor: false,
      sponsorWalletId: ''
    }
  };
}

/** The live state the mocks read. Mutate it through the setters below. */
export const cardanoEnvState: CardanoEnvState = blank();

/**
 * What a test file's `vi.mock` of `envHelper` should return.
 *
 * @param actual - The real module, from `importOriginal`.
 * @returns The same module with the readers answered from this state.
 */
export function cardanoEnvHelperMock<T extends object>(actual: T): T {
  return {
    ...actual,
    readCardanoEnv: () => ({ ...cardanoEnvState.env }),
    readCardanoFeeEnv: () => ({ ...cardanoEnvState.feeEnv })
  };
}

/**
 * What a test file's `vi.mock` of `constants` should return.
 *
 * The values are fixed and unrelated to anything deployed, so a suite that derives an address is a
 * property of the code rather than of the machine running it.
 *
 * @param actual - The real module, from `importOriginal`.
 * @returns The same module with the derivation inputs fixed.
 */
export function cardanoConstantsMock<T extends object>(actual: T): T {
  return Object.defineProperties(
    { ...actual },
    {
      $SC: { value: 'x', enumerable: true },
      $B: { value: 'y', enumerable: true },
      CDC1: { value: '743a643a', enumerable: true },
      CDC2: { value: '743a633a', enumerable: true },
      CDC3: { value: '7430', enumerable: true },
      CDC4: { value: '743a6b3a', enumerable: true },
      CDC5: { value: '743a733a', enumerable: true },
      CDC6: { value: '743a73733a', enumerable: true },
      CARDANO_DERIVATION_CHECK: { get: () => cardanoEnvState.derivationCheck, enumerable: true }
    }
  ) as T;
}

/**
 * Puts every Cardano setting back to unconfigured.
 *
 * @param overrides - What this test needs on top of the blank state.
 */
export function resetCardanoEnv(overrides: Partial<CardanoEnvState> = {}): void {
  const fresh = blank();
  cardanoEnvState.derivationCheck = overrides.derivationCheck ?? fresh.derivationCheck;
  cardanoEnvState.env = { ...fresh.env, ...overrides.env };
  cardanoEnvState.feeEnv = { ...fresh.feeEnv, ...overrides.feeEnv };
}

/**
 * Changes part of the configuration.
 *
 * @param patch - The settings to change.
 */
export function setCardanoEnv(patch: Partial<CardanoEnv>): void {
  cardanoEnvState.env = { ...cardanoEnvState.env, ...patch };
}

/**
 * Changes part of the fee configuration.
 *
 * @param patch - The settings to change.
 */
export function setCardanoFeeEnv(patch: Partial<CardanoFeeEnv>): void {
  cardanoEnvState.feeEnv = { ...cardanoEnvState.feeEnv, ...patch };
}

/** The usable configuration most suites want: the family on, against Preprod. */
export function enableCardanoPreprod(patch: Partial<CardanoEnv> = {}): void {
  resetCardanoEnv();
  setCardanoEnv({ enabled: true, network: 'preprod', ...patch });
}
