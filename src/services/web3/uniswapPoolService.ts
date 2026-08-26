import { ethers } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { getUniswapRouter02ABI } from './abiService';

/**
 * Minimal ABI for the Uniswap V3 factory. Only `getPool` is needed to tell an
 * existing pool from a non-existent one before attempting a swap.
 */
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

/** Minimal ABI for a Uniswap V3 pool: spot price and token ordering. */
const UNISWAP_V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)'
];

/** Minimal ABI for reading an ERC20 allowance. */
const ERC20_ALLOWANCE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)'
];

/** Q96 fixed-point scale used by Uniswap V3 for `sqrtPriceX96`. */
const Q96 = ethers.BigNumber.from(2).pow(96);

/** Denominator for Uniswap V3 fee tiers, which are expressed in hundredths of a bip. */
const FEE_DENOMINATOR = ethers.BigNumber.from(1_000_000);

/**
 * Result of quoting a swap against the real Uniswap V3 pool.
 */
export type PoolQuote = {
  /** Fee tier the ChatterPay contract will use for this pair (in hundredths of a bip). */
  fee: number;
  /** Address of the Uniswap V3 pool backing the quote. */
  pool: string;
  /** Output amount the pool would actually deliver for the given input. */
  amountOut: ethers.BigNumber;
  /**
   * How the amount was obtained. `simulation` replays the router call and is exact;
   * `spot` derives it from the pool price and ignores price impact.
   */
  source: 'simulation' | 'spot';
};

/**
 * Resolves the Uniswap V3 fee tier that ChatterPay will use for a token pair.
 *
 * Mirrors `ChatterPay._getPoolFee`: a custom fee registered for the pair wins, otherwise
 * the low tier is used when both tokens are stablecoins and the medium tier in every
 * other case. Keeping this in sync with the contract matters because quoting a different
 * fee tier than the one the swap executes against produces a quote for a pool that is
 * never touched.
 *
 * @param chatterPayContract - ChatterPay contract instance (proxy or implementation)
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Fee tier in hundredths of a bip (e.g. 500, 3000, 10000)
 */
export async function resolvePoolFee(
  chatterPayContract: ethers.Contract,
  tokenIn: string,
  tokenOut: string,
  logKey: string
): Promise<number> {
  const [tokenA, tokenB] =
    tokenIn.toLowerCase() < tokenOut.toLowerCase() ? [tokenIn, tokenOut] : [tokenOut, tokenIn];
  const pairHash = ethers.utils.solidityKeccak256(['address', 'address'], [tokenA, tokenB]);

  // `uint24` comes back as a plain number in ethers v5, not a BigNumber.
  const customFee = Number(await chatterPayContract.getCustomPoolFee(pairHash));
  if (customFee !== 0) {
    Logger.debug('resolvePoolFee', logKey, `Using custom pool fee: ${customFee}`);
    return customFee;
  }

  const [isInStable, isOutStable, poolFees] = await Promise.all([
    chatterPayContract.isStableToken(tokenIn),
    chatterPayContract.isStableToken(tokenOut),
    chatterPayContract.getPoolFees()
  ]);

  const fee = isInStable && isOutStable ? poolFees.low : poolFees.medium;
  Logger.debug(
    'resolvePoolFee',
    logKey,
    `Resolved pool fee: ${fee} (stableIn=${isInStable}, stableOut=${isOutStable})`
  );

  return Number(fee);
}

/**
 * Looks up the Uniswap V3 pool address for a pair and fee tier.
 *
 * Resolves the factory from the router itself so no extra network configuration is
 * required, and returns null when the factory has no pool registered for the tuple.
 *
 * @param provider - Ethers provider for blockchain interaction
 * @param routerAddress - Uniswap V3 SwapRouter address used by ChatterPay
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param fee - Fee tier in hundredths of a bip
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Pool address, or null when the pool does not exist
 */
export async function getPoolAddress(
  provider: ethers.providers.Provider,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  logKey: string
): Promise<string | null> {
  const routerABI = await getUniswapRouter02ABI();
  const router = new ethers.Contract(routerAddress, routerABI, provider);
  const factoryAddress: string = await router.factory();

  const factory = new ethers.Contract(factoryAddress, UNISWAP_V3_FACTORY_ABI, provider);
  const pool: string = await factory.getPool(tokenIn, tokenOut, fee);

  if (pool === ethers.constants.AddressZero) {
    Logger.debug(
      'getPoolAddress',
      logKey,
      `No pool for ${tokenIn}/${tokenOut} at fee ${fee} (factory ${factoryAddress})`
    );
    return null;
  }

  Logger.debug('getPoolAddress', logKey, `Pool for ${tokenIn}/${tokenOut} fee ${fee}: ${pool}`);
  return pool;
}

/**
 * Quotes a swap by simulating the exact router call the ChatterPay contract will make.
 *
 * A `callStatic` on `exactInputSingle` with `amountOutMinimum: 0` returns the output the
 * pool would really deliver, including the pool fee and the price impact of this specific
 * trade. That makes it a stronger reference than an off-chain price feed whenever the pool
 * price and the oracle price can diverge, which is the normal state of affairs on testnets
 * seeded with mock liquidity.
 *
 * The simulation runs `from` the wallet that holds the tokens so the router's `transferFrom`
 * sees the real balance and allowance.
 *
 * @param provider - Ethers provider for blockchain interaction
 * @param routerAddress - Uniswap V3 SwapRouter address used by ChatterPay
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param fee - Fee tier in hundredths of a bip
 * @param amountIn - Amount that will reach the router (ChatterPay fee already deducted)
 * @param wallet - Wallet/proxy address holding the tokens; acts as caller and recipient
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Output amount the pool would deliver
 * @throws Error if the router call reverts (no liquidity, missing allowance, etc.)
 */
export async function simulateExactInputSingle(
  provider: ethers.providers.Provider,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: ethers.BigNumber,
  wallet: string,
  logKey: string
): Promise<ethers.BigNumber> {
  const routerABI = await getUniswapRouter02ABI();
  const router = new ethers.Contract(routerAddress, routerABI, provider);

  const amountOut: ethers.BigNumber = await router.callStatic.exactInputSingle(
    {
      tokenIn,
      tokenOut,
      fee,
      recipient: wallet,
      amountIn,
      amountOutMinimum: ethers.constants.Zero,
      sqrtPriceLimitX96: ethers.constants.Zero
    },
    { from: wallet }
  );

  Logger.debug(
    'simulateExactInputSingle',
    logKey,
    `Pool simulation returned amountOut: ${amountOut.toString()}`
  );

  return amountOut;
}

/**
 * Derives the output amount from the pool's spot price, without touching the router.
 *
 * `sqrtPriceX96` encodes token1-per-token0 in raw units, so the decimals of both tokens are
 * already baked in and need no adjustment. The pool's own fee tier is deducted the same way
 * Uniswap does, but price impact is not modelled: this overstates the output for trades large
 * enough to move the pool, so it is a fallback rather than the primary quote.
 *
 * Its reason to exist is ordering. Both execution paths validate before approving, so on the
 * first swap of a token the wallet has no router allowance yet and a router simulation reverts
 * with `STF`. Reading the price needs neither allowance nor balance, which keeps validation
 * from deadlocking against the approval that would unblock it.
 *
 * @param provider - Ethers provider for blockchain interaction
 * @param pool - Uniswap V3 pool address
 * @param tokenIn - Input token address
 * @param fee - Fee tier in hundredths of a bip
 * @param amountIn - Amount that will reach the router (ChatterPay fee already deducted)
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Output amount implied by the current pool price, net of the pool fee
 * @throws Error if the pool has no price (never initialised)
 */
export async function quoteSpotAmountOut(
  provider: ethers.providers.Provider,
  pool: string,
  tokenIn: string,
  fee: number,
  amountIn: ethers.BigNumber,
  logKey: string
): Promise<ethers.BigNumber> {
  const poolContract = new ethers.Contract(pool, UNISWAP_V3_POOL_ABI, provider);
  const [slot0, token0] = await Promise.all([poolContract.slot0(), poolContract.token0()]);

  const sqrtPriceX96: ethers.BigNumber = slot0.sqrtPriceX96;
  if (sqrtPriceX96.isZero()) {
    throw new Error(`Uniswap pool ${pool} has no price: it was never initialised`);
  }

  // Deduct the pool fee first, exactly as Uniswap does before touching the curve.
  const amountInAfterFee = amountIn.mul(FEE_DENOMINATOR.sub(fee)).div(FEE_DENOMINATOR);

  // price(token1 per token0) = (sqrtPriceX96 / 2^96)^2. Multiplying before dividing keeps the
  // full precision of the Q96 representation.
  const isTokenInToken0 = tokenIn.toLowerCase() === token0.toLowerCase();
  const amountOut = isTokenInToken0
    ? amountInAfterFee.mul(sqrtPriceX96).div(Q96).mul(sqrtPriceX96).div(Q96)
    : amountInAfterFee.mul(Q96).div(sqrtPriceX96).mul(Q96).div(sqrtPriceX96);

  Logger.debug(
    'quoteSpotAmountOut',
    logKey,
    `Spot quote from pool ${pool}: ${amountOut.toString()} (tokenIn is token${isTokenInToken0 ? '0' : '1'})`
  );

  return amountOut;
}

/**
 * Reports whether the wallet has already approved the router to move `amount` of a token.
 *
 * @param provider - Ethers provider for blockchain interaction
 * @param token - Token to check
 * @param owner - Wallet that holds the tokens
 * @param spender - Router that would pull them
 * @param amount - Amount the router needs to move
 *
 * @returns True when the current allowance covers the amount
 */
async function hasRouterAllowance(
  provider: ethers.providers.Provider,
  token: string,
  owner: string,
  spender: string,
  amount: ethers.BigNumber
): Promise<boolean> {
  const erc20 = new ethers.Contract(token, ERC20_ALLOWANCE_ABI, provider);
  const allowance: ethers.BigNumber = await erc20.allowance(owner, spender);
  return allowance.gte(amount);
}

/**
 * Quotes a swap against the real Uniswap V3 pool ChatterPay will trade on.
 *
 * Resolves the fee tier exactly as the contract does, verifies the pool exists, and
 * simulates the router call. Failing here is cheap and produces an actionable message,
 * whereas letting the flow continue means broadcasting a transaction that reverts and
 * burns gas.
 *
 * @param provider - Ethers provider for blockchain interaction
 * @param chatterPayContract - ChatterPay contract instance used to resolve the fee tier
 * @param routerAddress - Uniswap V3 SwapRouter address used by ChatterPay
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param swapAmount - Amount that will reach the router (ChatterPay fee already deducted)
 * @param wallet - Wallet/proxy address holding the tokens
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Fee tier, pool address and the output amount the pool would deliver
 * @throws Error if no pool exists for the pair or the simulation reverts
 */
export async function quoteAmountOutViaPool(
  provider: ethers.providers.Provider,
  chatterPayContract: ethers.Contract,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  swapAmount: ethers.BigNumber,
  wallet: string,
  logKey: string
): Promise<PoolQuote> {
  const fee = await resolvePoolFee(chatterPayContract, tokenIn, tokenOut, logKey);

  const pool = await getPoolAddress(provider, routerAddress, tokenIn, tokenOut, fee, logKey);
  if (!pool) {
    throw new Error(
      `No Uniswap V3 pool exists for ${tokenIn}/${tokenOut} at fee tier ${fee}. ` +
        `The pool must be created and seeded with liquidity before this pair can be swapped.`
    );
  }

  // Both execution paths validate before approving, so on a token's first swap the router has
  // no allowance yet and a simulation would revert with `STF` — failing validation and thereby
  // preventing the very approval that would fix it. Check first and price off the pool instead.
  const canSimulate = await hasRouterAllowance(
    provider,
    tokenIn,
    wallet,
    routerAddress,
    swapAmount
  );

  let amountOut: ethers.BigNumber;
  let source: PoolQuote['source'];

  if (canSimulate) {
    try {
      amountOut = await simulateExactInputSingle(
        provider,
        routerAddress,
        tokenIn,
        tokenOut,
        fee,
        swapAmount,
        wallet,
        logKey
      );
      source = 'simulation';
    } catch (error) {
      const reason =
        (error as { reason?: string })?.reason ??
        (error instanceof Error ? error.message : 'Unknown error');
      throw new Error(
        `Uniswap pool simulation reverted for ${tokenIn}/${tokenOut} at fee tier ${fee} (pool ${pool}): ${reason}`
      );
    }
  } else {
    Logger.info(
      'quoteAmountOutViaPool',
      logKey,
      `Router allowance not yet granted for ${tokenIn}; pricing off the pool spot instead of simulating`
    );
    amountOut = await quoteSpotAmountOut(provider, pool, tokenIn, fee, swapAmount, logKey);
    source = 'spot';
  }

  if (amountOut.lte(0)) {
    throw new Error(
      `Uniswap pool ${pool} returned a zero output for ${tokenIn}/${tokenOut} at fee tier ${fee}.`
    );
  }

  return { fee, pool, amountOut, source };
}

export const uniswapPoolService = {
  resolvePoolFee,
  getPoolAddress,
  simulateExactInputSingle,
  quoteSpotAmountOut,
  quoteAmountOutViaPool
};
