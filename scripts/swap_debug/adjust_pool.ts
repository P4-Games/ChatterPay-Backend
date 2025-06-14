/**
 * @file adjust_pool.ts
 * @description Adjusts a Uniswap V3 pool price on testnet to match a target price,
 * ensuring all preconditions are validated before executing the swap.
 */

import { ethers } from 'ethers';

import { resolveRpcUrl } from './common';
import { executeSwap } from './swap_tokens';
import { Logger } from '../../src/helpers/loggerHelper';
import { ABI } from '../../src/services/web3/abiService';
import { coingeckoService } from '../../src/services/coingecko/coingeckoService';

interface PoolConfig {
  readonly rpc: string;
  readonly privateKey: string;
  readonly usdtAddress: string;
  readonly wethAddress: string;
  readonly poolFee: number;
  readonly swapRouterAddress: string;
  readonly factoryAddress: string;
  readonly gasLimit: number;
}

interface TokenBalances {
  readonly poolBalanceA: ethers.BigNumber;
  readonly poolBalanceB: ethers.BigNumber;
  readonly tokenADecimals: number;
  readonly tokenBDecimals: number;
}

const getConfig = (): PoolConfig => {
  const requiredEnvVars = [
    'SIGNING_KEY',
    'USDT_ADDRESS',
    'WETH_ADDRESS',
    'POOL_FEE',
    'SWAP_ROUTER',
    'UNISWAP_FACTORY'
  ];
  requiredEnvVars.forEach((key) => {
    if (!process.env[key]) throw new Error(`Missing env variable: ${key}`);
  });

  return {
    rpc: resolveRpcUrl(),
    privateKey: process.env.SIGNING_KEY!,
    usdtAddress: process.env.USDT_ADDRESS ?? '',
    wethAddress: process.env.WETH_ADDRESS ?? '',
    poolFee: parseInt(process.env.POOL_FEE ?? '3000', 10),
    swapRouterAddress: process.env.SWAP_ROUTER ?? '',
    factoryAddress: process.env.UNISWAP_FACTORY ?? '',
    gasLimit: 3000000
  };
};

const ERC20_ABI: ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function mint(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

const FACTORY_ABI: ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
];

const calculateSwapForTargetPrice = (
  reserve0: ethers.BigNumber,
  reserve1: ethers.BigNumber,
  targetPrice: number
): number => {
  const reserve0Num = parseFloat(ethers.utils.formatUnits(reserve0, 18));
  const reserve1Num = parseFloat(ethers.utils.formatUnits(reserve1, 18));
  const k = reserve0Num * reserve1Num;
  const newReserve1 = Math.sqrt(k / targetPrice);
  const newReserve0 = targetPrice * newReserve1;
  return newReserve0 - reserve0Num;
};

const getPoolAddress = async (
  tokenA: string,
  tokenB: string,
  config: PoolConfig,
  provider: ethers.providers.JsonRpcProvider
): Promise<string> => {
  const factory = new ethers.Contract(config.factoryAddress, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(tokenA, tokenB, config.poolFee);
  if (poolAddress === ethers.constants.AddressZero) {
    Logger.error(`Pool not found for ${tokenA}, ${tokenB} with fee ${config.poolFee}`);
    throw new Error('Pool not deployed');
  }
  return poolAddress;
};

const getPoolBalances = async (
  tokenA: string,
  tokenB: string,
  config: PoolConfig,
  provider: ethers.providers.JsonRpcProvider
): Promise<TokenBalances> => {
  const poolAddress = await getPoolAddress(tokenA, tokenB, config, provider);
  const tokenAContract = new ethers.Contract(tokenA, ERC20_ABI, provider);
  const tokenBContract = new ethers.Contract(tokenB, ERC20_ABI, provider);

  const [balanceA, decimalsA, balanceB, decimalsB] = await Promise.all([
    tokenAContract.balanceOf(poolAddress),
    tokenAContract.decimals(),
    tokenBContract.balanceOf(poolAddress),
    tokenBContract.decimals()
  ]);

  return {
    poolBalanceA: balanceA,
    tokenADecimals: decimalsA,
    poolBalanceB: balanceB,
    tokenBDecimals: decimalsB
  };
};

const validateSwapPreconditions = async (
  wallet: ethers.Wallet,
  tokenIn: string,
  amount: ethers.BigNumber,
  router: string
): Promise<boolean> => {
  const token = new ethers.Contract(tokenIn, ERC20_ABI, wallet);
  const balance = await token.balanceOf(wallet.address);
  const allowance = await token.allowance(wallet.address, router);

  if (balance.lt(amount)) {
    Logger.error(`Insufficient balance for token ${tokenIn}`);
    return false;
  }
  if (allowance.lt(amount)) {
    Logger.error(`Router allowance too low for token ${tokenIn}`);
    return false;
  }
  return true;
};

async function main() {
  try {
    Logger.info('Starting pool adjustment script...');
    const config = getConfig();

    const targetPrice = await coingeckoService.getTokenPrice('ethereum');
    Logger.info(`Target price: ${targetPrice} USDT per ETH`);

    const provider = new ethers.providers.JsonRpcProvider(config.rpc);
    const wallet = new ethers.Wallet(config.privateKey, provider);

    const { poolBalanceA, poolBalanceB, tokenADecimals, tokenBDecimals } = await getPoolBalances(
      config.usdtAddress,
      config.wethAddress,
      config,
      provider
    );

    const isBuy = calculateSwapForTargetPrice(poolBalanceA, poolBalanceB, targetPrice) > 0;

    const tokenIn = isBuy ? config.wethAddress : config.usdtAddress;
    const tokenOut = isBuy ? config.usdtAddress : config.wethAddress;
    const decimals = isBuy ? tokenBDecimals : tokenADecimals;

    const tokenContract = new ethers.Contract(tokenIn, ERC20_ABI, wallet);
    const walletBalance = await tokenContract.balanceOf(wallet.address);
    const walletBalanceFloat = parseFloat(ethers.utils.formatUnits(walletBalance, decimals));
    const maxUsableFloat = walletBalanceFloat * 0.9;
    const amount = ethers.utils.parseUnits(maxUsableFloat.toFixed(decimals), decimals);

    Logger.info(`Wallet Balance: ${walletBalanceFloat} ${isBuy ? 'WETH' : 'USDT'}`);
    Logger.info(
      `Final amount to swap: ${ethers.utils.formatUnits(amount, decimals)} ${isBuy ? 'WETH' : 'USDT'} (capped at 90% of wallet balance)`
    );

    if (!(await validateSwapPreconditions(wallet, tokenIn, amount, config.swapRouterAddress))) {
      Logger.error('Preconditions for swap failed, aborting.');
      return;
    }

    Logger.info(
      `Swapping ${ethers.utils.formatUnits(amount, decimals)} ${isBuy ? 'WETH' : 'USDT'} for ${isBuy ? 'USDT' : 'WETH'}`
    );

    await executeSwap({
      config,
      amountIn: ethers.utils.formatUnits(amount, decimals),
      tokenIn,
      tokenOut
    });

    Logger.info('Swap executed successfully.');
  } catch (error) {
    Logger.error(`Execution error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
