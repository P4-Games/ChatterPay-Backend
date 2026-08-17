import { beforeEach, describe, expect, it } from 'vitest';

import {
  getCardanoBalance,
  isCardanoWalletAddress
} from '../../../src/services/cardano/cardanoBalanceService';
import { CARDANO_PREPROD_CHAIN_ID } from '../../../src/config/cardanoConfig';
import Token from '../../../src/models/tokenModel';
import { CardanoProviderError } from '../../../src/services/cardano/cardanoProviderService';
import { FakeCardanoProvider } from '../../helpers/fakeCardanoProvider';

const ADDRESS = 'addr_test1vrhdandhv2ngazdseql7v5fkg5utnu629anv9zt25x8vrsqn2mhal';
const MAINNET_ADDRESS = 'addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8';

/** A native stablecoin, shaped like the real thing. */
const USDM = {
  policyId: 'a1'.repeat(28),
  assetName: Buffer.from('USDM').toString('hex')
};

let provider: FakeCardanoProvider;

beforeEach(() => {
  process.env.CARDANO_ENABLED = 'true';
  process.env.CARDANO_NETWORK = 'preprod';
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

  it('separates ADA locked beside native assets from what can be spent', async () => {
    // Reporting only the spendable part would make the balance disagree with every explorer;
    // reporting the total would promise funds a transfer then refuses to move. Both are returned.
    provider.fund(ADDRESS, 5_000_000n).fundWithNativeAssets(ADDRESS, 3_000_000n);

    const balance = await getCardanoBalance(ADDRESS, provider);

    expect(balance.totalAda).toBe('8.000000');
    expect(balance.spendableAda).toBe('5.000000');
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
