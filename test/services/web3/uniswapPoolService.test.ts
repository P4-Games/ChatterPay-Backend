import { ethers } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getPoolAddress,
  quoteAmountOutViaPool,
  quoteSpotAmountOut,
  resolvePoolFee,
  simulateExactInputSingle
} from '../../../src/services/web3/uniswapPoolService';

vi.mock('../../../src/services/web3/abiService', () => ({
  getUniswapRouter02ABI: vi.fn(async () => [])
}));

const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
const FACTORY = '0x4444444444444444444444444444444444444444';
const POOL = '0x5555555555555555555555555555555555555555';
const WALLET = '0x6666666666666666666666666666666666666666';

/** Builds a ChatterPay contract double exposing only the getters the service reads. */
function chatterPayDouble({
  customPoolFee = 0,
  stable = {} as Record<string, boolean>,
  poolFees = { low: 500, medium: 3000, high: 10000 }
} = {}) {
  return {
    getCustomPoolFee: vi.fn(async () => customPoolFee),
    isStableToken: vi.fn(async (token: string) => stable[token.toLowerCase()] ?? false),
    getPoolFees: vi.fn(async () => poolFees)
  } as unknown as ethers.Contract;
}

/**
 * Stubs `ethers.Contract` so the factory/router lookups resolve without a provider.
 * `getPool` and `exactInputSingle` are supplied per test.
 */
function stubContracts({
  getPool,
  exactInputSingle,
  allowance = ethers.constants.MaxUint256,
  sqrtPriceX96 = ethers.BigNumber.from('1834821501228792017703123664'),
  token0 = TOKEN_A
}: {
  getPool?: (a: string, b: string, fee: number) => Promise<string>;
  exactInputSingle?: (params: unknown, overrides: unknown) => Promise<ethers.BigNumber>;
  allowance?: ethers.BigNumber;
  sqrtPriceX96?: ethers.BigNumber;
  token0?: string;
}) {
  return vi.spyOn(ethers, 'Contract').mockImplementation(
    (address: string) =>
      ({
        address,
        factory: async () => FACTORY,
        getPool,
        allowance: async () => allowance,
        slot0: async () => ({ sqrtPriceX96 }),
        token0: async () => token0,
        callStatic: { exactInputSingle }
      }) as unknown as ethers.Contract
  );
}

describe('uniswapPoolService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolvePoolFee', () => {
    it('uses the low tier when both tokens are stable', async () => {
      const contract = chatterPayDouble({
        stable: { [TOKEN_A.toLowerCase()]: true, [TOKEN_B.toLowerCase()]: true }
      });

      await expect(resolvePoolFee(contract, TOKEN_A, TOKEN_B, 'k')).resolves.toBe(500);
    });

    it('uses the medium tier when either token is not stable', async () => {
      const contract = chatterPayDouble({ stable: { [TOKEN_A.toLowerCase()]: true } });

      await expect(resolvePoolFee(contract, TOKEN_A, TOKEN_B, 'k')).resolves.toBe(3000);
    });

    it('prefers a custom fee registered for the pair', async () => {
      const contract = chatterPayDouble({
        customPoolFee: 10000,
        stable: { [TOKEN_A.toLowerCase()]: true, [TOKEN_B.toLowerCase()]: true }
      });

      await expect(resolvePoolFee(contract, TOKEN_A, TOKEN_B, 'k')).resolves.toBe(10000);
    });

    it('hashes the pair in a token-order independent way', async () => {
      const contract = chatterPayDouble();
      await resolvePoolFee(contract, TOKEN_A, TOKEN_B, 'k');
      await resolvePoolFee(contract, TOKEN_B, TOKEN_A, 'k');

      const calls = (contract.getCustomPoolFee as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toBe(calls[1][0]);
    });
  });

  describe('getPoolAddress', () => {
    it('returns null when the factory has no pool for the tuple', async () => {
      stubContracts({ getPool: async () => ethers.constants.AddressZero });

      const provider = {} as ethers.providers.Provider;
      await expect(
        getPoolAddress(provider, ROUTER, TOKEN_A, TOKEN_B, 500, 'k')
      ).resolves.toBeNull();
    });

    it('returns the pool address when one exists', async () => {
      stubContracts({ getPool: async () => POOL });

      const provider = {} as ethers.providers.Provider;
      await expect(getPoolAddress(provider, ROUTER, TOKEN_A, TOKEN_B, 500, 'k')).resolves.toBe(
        POOL
      );
    });
  });

  describe('simulateExactInputSingle', () => {
    it('simulates with no minimum output and the wallet as caller and recipient', async () => {
      const exactInputSingle = vi.fn(async (_params: unknown, _overrides: unknown) =>
        ethers.BigNumber.from('9235050006558805000')
      );
      stubContracts({ exactInputSingle });

      const provider = {} as ethers.providers.Provider;
      const amountOut = await simulateExactInputSingle(
        provider,
        ROUTER,
        TOKEN_A,
        TOKEN_B,
        3000,
        ethers.BigNumber.from('4967641396620640'),
        WALLET,
        'k'
      );

      expect(amountOut.toString()).toBe('9235050006558805000');

      const [params, overrides] = exactInputSingle.mock.calls[0] as unknown as [
        Record<string, unknown>,
        Record<string, unknown>
      ];
      expect(params.amountOutMinimum).toEqual(ethers.constants.Zero);
      expect(params.recipient).toBe(WALLET);
      expect(params.fee).toBe(3000);
      expect(overrides.from).toBe(WALLET);
    });
  });

  describe('quoteAmountOutViaPool', () => {
    const provider = {} as ethers.providers.Provider;

    it('quotes the pool the contract will actually trade on', async () => {
      const exactInputSingle = vi.fn(async () => ethers.BigNumber.from('9235050006558805000'));
      const getPool = vi.fn(async () => POOL);
      stubContracts({ getPool, exactInputSingle });

      const contract = chatterPayDouble({ stable: { [TOKEN_B.toLowerCase()]: true } });
      const quote = await quoteAmountOutViaPool(
        provider,
        contract,
        ROUTER,
        TOKEN_A,
        TOKEN_B,
        ethers.BigNumber.from('4967641396620640'),
        WALLET,
        'k'
      );

      expect(quote.fee).toBe(3000);
      expect(quote.pool).toBe(POOL);
      expect(quote.amountOut.toString()).toBe('9235050006558805000');
      expect(quote.source).toBe('simulation');
      expect(getPool).toHaveBeenCalledWith(TOKEN_A, TOKEN_B, 3000);
    });

    it('fails with an actionable message when the pair has no pool', async () => {
      stubContracts({ getPool: async () => ethers.constants.AddressZero });

      const contract = chatterPayDouble({
        stable: { [TOKEN_A.toLowerCase()]: true, [TOKEN_B.toLowerCase()]: true }
      });

      await expect(
        quoteAmountOutViaPool(
          provider,
          contract,
          ROUTER,
          TOKEN_A,
          TOKEN_B,
          ethers.BigNumber.from('10'),
          WALLET,
          'k'
        )
      ).rejects.toThrow(/No Uniswap V3 pool exists .* at fee tier 500/);
    });

    it('surfaces the router revert reason instead of swallowing it', async () => {
      stubContracts({
        getPool: async () => POOL,
        exactInputSingle: async () => {
          throw Object.assign(new Error('call revert exception'), {
            reason: 'Too little received'
          });
        }
      });

      const contract = chatterPayDouble();

      await expect(
        quoteAmountOutViaPool(
          provider,
          contract,
          ROUTER,
          TOKEN_A,
          TOKEN_B,
          ethers.BigNumber.from('10'),
          WALLET,
          'k'
        )
      ).rejects.toThrow(/Too little received/);
    });

    it('rejects a pool that would return nothing', async () => {
      stubContracts({
        getPool: async () => POOL,
        exactInputSingle: async () => ethers.constants.Zero
      });

      const contract = chatterPayDouble();

      await expect(
        quoteAmountOutViaPool(
          provider,
          contract,
          ROUTER,
          TOKEN_A,
          TOKEN_B,
          ethers.BigNumber.from('10'),
          WALLET,
          'k'
        )
      ).rejects.toThrow(/zero output/);
    });

    it('prices off the pool spot when the router has no allowance yet', async () => {
      // Both execution paths validate before approving, so the first swap of a token must not
      // depend on a router allowance that does not exist yet.
      const exactInputSingle = vi.fn(async () => ethers.BigNumber.from('1'));
      stubContracts({
        getPool: async () => POOL,
        exactInputSingle,
        allowance: ethers.constants.Zero,
        token0: TOKEN_B
      });

      const contract = chatterPayDouble();
      const quote = await quoteAmountOutViaPool(
        provider,
        contract,
        ROUTER,
        TOKEN_A,
        TOKEN_B,
        ethers.BigNumber.from('4967641396620640'),
        WALLET,
        'k'
      );

      expect(quote.source).toBe('spot');
      expect(exactInputSingle).not.toHaveBeenCalled();
      // Same pool state the live WETH->USDT simulation returned 9.2346e18 for.
      expect(Number(ethers.utils.formatUnits(quote.amountOut, 18))).toBeCloseTo(9.2346, 3);
    });

    it('simulates rather than using spot once the allowance covers the amount', async () => {
      const exactInputSingle = vi.fn(async () => ethers.BigNumber.from('9235050006558805000'));
      stubContracts({
        getPool: async () => POOL,
        exactInputSingle,
        allowance: ethers.BigNumber.from('4967641396620640')
      });

      const contract = chatterPayDouble();
      const quote = await quoteAmountOutViaPool(
        provider,
        contract,
        ROUTER,
        TOKEN_A,
        TOKEN_B,
        ethers.BigNumber.from('4967641396620640'),
        WALLET,
        'k'
      );

      expect(quote.source).toBe('simulation');
      expect(exactInputSingle).toHaveBeenCalled();
    });
  });

  describe('quoteSpotAmountOut', () => {
    const provider = {} as ethers.providers.Provider;

    it('rejects a pool that was never initialised', async () => {
      stubContracts({ sqrtPriceX96: ethers.constants.Zero });

      await expect(
        quoteSpotAmountOut(provider, POOL, TOKEN_A, 3000, ethers.BigNumber.from('1000'), 'k')
      ).rejects.toThrow(/never initialised/);
    });

    it('inverts the price depending on which side of the pool tokenIn sits', async () => {
      const amountIn = ethers.BigNumber.from('4967641396620640');

      stubContracts({ token0: TOKEN_A });
      const asToken0 = await quoteSpotAmountOut(provider, POOL, TOKEN_A, 3000, amountIn, 'k');

      stubContracts({ token0: TOKEN_B });
      const asToken1 = await quoteSpotAmountOut(provider, POOL, TOKEN_A, 3000, amountIn, 'k');

      expect(asToken0.lt(amountIn)).toBe(true);
      expect(asToken1.gt(amountIn)).toBe(true);
    });

    it('deducts the pool fee tier from the input', async () => {
      const amountIn = ethers.BigNumber.from('1000000000000000000');
      stubContracts({ token0: TOKEN_B });

      const low = await quoteSpotAmountOut(provider, POOL, TOKEN_A, 500, amountIn, 'k');
      const high = await quoteSpotAmountOut(provider, POOL, TOKEN_A, 10000, amountIn, 'k');

      expect(low.gt(high)).toBe(true);
    });
  });
});
