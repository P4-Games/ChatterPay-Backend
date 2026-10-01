import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADA_ADDRESS_PREFIX, CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import CardanoStakingAccount from '../../../src/models/cardanoStakingAccountModel';
import Token from '../../../src/models/tokenModel';
import {
  getCardanoBalance,
  getCardanoTokenBalances,
  isCardanoWalletAddress
} from '../../../src/services/cardano/cardanoBalanceService';
import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import { FakeCardanoProvider } from '../../helpers/fakeCardanoProvider';
import { enableCardanoPreprod } from '../../support/cardanoEnv';

vi.mock('../../../src/helpers/envHelper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/helpers/envHelper')>();
  const { cardanoEnvHelperMock } = await import('../../support/cardanoEnv');
  return cardanoEnvHelperMock(actual);
});

vi.mock('../../../src/config/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/constants')>();
  const { cardanoConstantsMock } = await import('../../support/cardanoEnv');
  return cardanoConstantsMock(actual);
});

const ADDRESS = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';
const MAINNET_ADDRESS = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';

/** A native stablecoin, shaped like the real thing. */
const USDM = {
  policyId: 'a1'.repeat(28),
  assetName: Buffer.from('USDM').toString('hex')
};

let provider: FakeCardanoProvider;

beforeEach(() => {
  enableCardanoPreprod();
  provider = new FakeCardanoProvider();
});

describe('isCardanoWalletAddress', () => {
  it('accepts an address of the configured network', () => {
    expect(isCardanoWalletAddress(ADDRESS)).toBe(true);
  });

  it('rejects an address of the other network', () => {
    expect(isCardanoWalletAddress(MAINNET_ADDRESS)).toBe(false);
  });

  it('rejects EVM addresses, so the balance endpoint keeps routing them to the EVM path', () => {
    expect(isCardanoWalletAddress('0x742d35Cc6634C0532925a3b844Bc454e4438f44e')).toBe(false);
    expect(isCardanoWalletAddress('')).toBe(false);
  });
});

describe('getCardanoBalance', () => {
  it('is zero for an address nobody has funded', async () => {
    const balance = await getCardanoBalance(ADDRESS, provider);
    expect(balance.spendableAda).toBe('0.000000');
    expect(balance.totalAda).toBe('0.000000');
    expect(balance.utxoCount).toBe(0);
  });

  it('sums the unspent outputs', async () => {
    provider.fund(ADDRESS, 15_000_000n).fund(ADDRESS, 2_500_000n);

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.totalAda).toBe('17.500000');
    expect(balance.spendableAda).toBe('17.500000');
    expect(balance.spendable).toBe(17.5);
    expect(balance.utxoCount).toBe(2);
  });

  it('reports each native asset held, with its ticker when it is configured', async () => {
    await Token.create({
      name: 'USDM',
      symbol: 'USDM',
      display_symbol: 'USDM',
      chain_id: CARDANO_PREPROD_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: `${USDM.policyId}${USDM.assetName}`,
      type: 'stable',
      ramp_enabled: false,
      operations_limits: {
        transfer: { L1: { min: 1, max: 1000 }, L2: { min: 1, max: 1000 } },
        swap: { L1: { min: 0, max: 0 }, L2: { min: 0, max: 0 } }
      }
    });
    provider.fundWithAssets(ADDRESS, 5_000_000n, [{ ...USDM, quantity: 30_500_000n }]);

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.assets).toHaveLength(1);
    expect(balance.assets[0].symbol).toBe('USDM');
    // Raw quantity from the chain, and the scaled figure from the catalogue's decimals.
    expect(balance.assets[0].quantity).toBe('30500000');
    expect(balance.assets[0].balance).toBe('30.500000');
    expect(balance.assets[0].policyId).toBe(USDM.policyId);
  });

  it('still reports an asset nobody configured, just without a ticker', async () => {
    // Hiding it would make the balance disagree with any explorer. The user holds it either way.
    provider.fundWithAssets(ADDRESS, 5_000_000n, [{ ...USDM, quantity: 7n }]);

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.assets).toHaveLength(1);
    expect(balance.assets[0].symbol).toBeUndefined();
    expect(balance.assets[0].balance).toBeUndefined();
    expect(balance.assets[0].quantity).toBe('7');
  });

  it('sums an asset spread across several outputs into one entry', async () => {
    provider
      .fundWithAssets(ADDRESS, 3_000_000n, [{ ...USDM, quantity: 20_000_000n }])
      .fundWithAssets(ADDRESS, 3_000_000n, [{ ...USDM, quantity: 5_000_000n }]);

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.assets).toHaveLength(1);
    expect(balance.assets[0].quantity).toBe('25000000');
  });

  it('counts ADA sitting beside native assets as spendable, and still reports it apart', async () => {
    // It used to be excluded, on the grounds that an ADA transfer could not spend such an output.
    // It can now — the change output carries the tokens home — so leaving it out understated the
    // balance by a whole output, which is what made a wallet look robbed after sending a token.
    provider.fund(ADDRESS, 5_000_000n).fundWithNativeAssets(ADDRESS, 3_000_000n);

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.totalAda).toBe('8.000000');
    expect(balance.spendableAda).toBe('8.000000');
    expect(balance.lockedWithAssetsAda).toBe('3.000000');
    expect(balance.utxoCount).toBe(2);
  });

  it('returns zeroes instead of throwing when the provider fails', async () => {
    // This is a dashboard read. A balance endpoint that throws takes the whole wallet view down
    // with it, so the failure is logged and classified rather than propagated.
    provider.failNextRead(new CardanoProviderError('rate_limited', 'CARDANO_PROVIDER_429'));

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.spendableAda).toBe('0.000000');
    expect(balance.utxoCount).toBe(0);
    expect(balance.address).toBe(ADDRESS);
  });
});

describe('getCardanoTokenBalances', () => {
  const adaRow = (balances: { symbol: string; balance: string | number }[]) =>
    balances.find((row) => row.symbol === 'ADA')?.balance;

  beforeEach(async () => {
    await Token.deleteMany({});
    await CardanoStakingAccount.deleteMany({});
    await Token.create({
      name: 'Cardano',
      symbol: 'ADA',
      display_symbol: 'ADA',
      chain_id: CARDANO_PREPROD_CHAIN_ID,
      decimals: 6,
      display_decimals: 2,
      address: `${ADA_ADDRESS_PREFIX}ada`,
      type: 'volatile',
      ramp_enabled: false,
      operations_limits: {
        transfer: { L1: { min: 1, max: 1000 }, L2: { min: 1, max: 1000 } },
        swap: { L1: { min: 0, max: 0 }, L2: { min: 0, max: 0 } }
      }
    });
  });

  /** A registered credential whose deposit and rewards are the user's. */
  async function stakedAccount(depositLovelace: string, withdrawableRewardsLovelace: string) {
    await CardanoStakingAccount.create({
      userId: new Types.ObjectId(),
      chainId: CARDANO_PREPROD_CHAIN_ID,
      walletAddress: ADDRESS,
      rewardAddress: 'stake_test1uqwv9u9kpmjufmdhhnzxgyrc05uf2wwdmadkfuqpyvztj8d',
      stakeCredentialHex: 'ce3b525279e269bac5368d404508d9fa9c527bda6eadbf639fed1767',
      onChain: {
        registered: true,
        poolId: 'pool1abc',
        governanceDelegation: null,
        depositLovelace,
        withdrawableRewardsLovelace,
        pendingRewardsLovelace: '9000000',
        lifetimeRewardsLovelace: '0',
        historicalCompleteness: 'partial',
        asOf: new Date()
      }
    });
  }

  it('reports the outputs alone for a wallet that is not staking', async () => {
    provider.fund(ADDRESS, 10_000_000n);

    const { balances } = await getCardanoTokenBalances(ADDRESS, () => 0, provider);

    expect(adaRow(balances)).toBe('10.000000');
  });

  it('keeps the registration deposit and withdrawable rewards in the ADA row once staking', async () => {
    // Registering moves the deposit out of the outputs. Without it the portfolio would show the
    // user two ada less than the staking screen does. Pending rewards stay out, as they do there.
    provider.fund(ADDRESS, 8_000_000n);
    await stakedAccount('2000000', '500000');

    const { balances, raw } = await getCardanoTokenBalances(ADDRESS, () => 0, provider);

    expect(adaRow(balances)).toBe('10.500000');
    // What a transfer can move is still the outputs.
    expect(raw.spendableAda).toBe('8.000000');
  });

  it('reads the outputs once for both figures', async () => {
    provider.fund(ADDRESS, 8_000_000n);
    await stakedAccount('2000000', '0');
    const reads = vi.spyOn(provider, 'utxosFor');

    await getCardanoTokenBalances(ADDRESS, () => 0, provider);

    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('falls back to zero rather than throwing when the provider fails', async () => {
    await stakedAccount('2000000', '0');
    provider.failNextRead(new CardanoProviderError('rate_limited', 'CARDANO_PROVIDER_429'));

    const { balances } = await getCardanoTokenBalances(ADDRESS, () => 0, provider);

    expect(adaRow(balances)).toBe('0.000000');
  });
});
