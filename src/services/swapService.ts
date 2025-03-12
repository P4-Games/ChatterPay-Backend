import { ethers, ContractInterface } from 'ethers';

import { IToken } from '../models/tokenModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenInfo } from './blockchainService';
import { IBlockchain } from '../models/blockchainModel';
import { executeUserOperationWithRetry } from './web3/userOperationService';
import { getERC20ABI, getChatterpayABI, getChainlinkPriceFeedABI } from './web3/abiService';
import {
  logPaymasterEntryPointDeposit,
  getPaymasterEntryPointDepositValue
} from './web3/paymasterService';
import {
  TokenAddresses,
  ExecuteSwapResult,
  SetupContractReturn,
  ExecueTransactionResult
} from '../types/commonType';
import {
  BINANCE_API_URL,
  SWAP_SLIPPAGE_CONFIG_EXTRA,
  SWAP_SLIPPAGE_CONFIG_STABLE,
  SWAP_SLIPPAGE_CONFIG_DEFAULT
} from '../config/constants';

/**
 * Constants for slippage configurations based on token types
 */
const SLIPPAGE_CONFIG = {
  STABLE: SWAP_SLIPPAGE_CONFIG_STABLE,
  DEFAULT: SWAP_SLIPPAGE_CONFIG_DEFAULT,
  EXTRA: SWAP_SLIPPAGE_CONFIG_EXTRA
} as const;

/**
 * Creates the encoded call data for a swap execution
 */
function createSwapCallData(
  chatterPayContract: ethers.Contract,
  tokenIn: string,
  tokenOut: string,
  amountIn: ethers.BigNumber,
  amountOutMin: ethers.BigNumber,
  recipient: string
): string {
  Logger.debug(
    'createSwapCallData',
    `Creating swap call data. TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountIn.toString()}, AmountOutMin: ${amountOutMin.toString()}, Recipient: ${recipient}`
  );

  const swapEncode = chatterPayContract.interface.encodeFunctionData('executeSwap', [
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    recipient
  ]);

  Logger.debug('createSwapCallData', `Generated swap encode: ${swapEncode}`);
  return swapEncode;
}

/**
 * Fetches and determines the appropriate slippage for a token
 */
async function determineSlippage(
  chatterPayContract: ethers.Contract,
  tokenSymbol: string,
  isStable: boolean,
  tokenOut: string
): Promise<number> {
  Logger.debug('determineSlippage', `Determining slippage for token ${tokenSymbol}`);

  const customSlippage = await chatterPayContract.getCustomSlippage(tokenOut);
  Logger.debug('determineSlippage', `Custom slippage: ${customSlippage.toString()}`);

  if (customSlippage.gt(0)) {
    Logger.info('determineSlippage', `Using custom slippage: ${customSlippage.toString()}`);
    return customSlippage.toNumber();
  }

  if (isStable) {
    Logger.info(
      'determineSlippage',
      `Using stable token slippage (${SLIPPAGE_CONFIG.STABLE}) for ${tokenSymbol}`
    );
    return SLIPPAGE_CONFIG.STABLE;
  }

  Logger.info(
    'determineSlippage',
    `Using default slippage (${SLIPPAGE_CONFIG.DEFAULT}) for ${tokenSymbol}`
  );
  return SLIPPAGE_CONFIG.DEFAULT;
}

/**
 * Helper Functions
 */

async function getTokenDecimals(
  tokenAddress: string,
  erc20ABI: ContractInterface,
  provider: ethers.providers.Provider
): Promise<number> {
  Logger.debug('getTokenDecimals', `Fetching decimals for token: ${tokenAddress}`);
  const token = new ethers.Contract(tokenAddress, erc20ABI, provider);
  const decimals = await token.decimals();
  Logger.debug('getTokenDecimals', `Token decimals: ${decimals}`);
  return decimals;
}

async function getTokenSymbol(
  tokenAddress: string,
  erc20ABI: ContractInterface,
  provider: ethers.providers.Provider
): Promise<string> {
  Logger.debug('getTokenSymbol', `Fetching symbol for token: ${tokenAddress}`);
  const token = new ethers.Contract(tokenAddress, erc20ABI, provider);
  const symbol = await token.symbol();
  Logger.debug('getTokenSymbol', `Token symbol: ${symbol}`);
  return symbol;
}

async function getChainlinkPrice(
  priceFeedAddress: string,
  priceFeedABI: ContractInterface,
  provider: ethers.providers.Provider
): Promise<number> {
  Logger.debug('getChainlinkPrice', `Fetching Chainlink price from feed: ${priceFeedAddress}`);
  const priceFeed = new ethers.Contract(priceFeedAddress, priceFeedABI, provider);
  const roundData = await priceFeed.latestRoundData();
  Logger.debug('getChainlinkPrice', `Latest round data: ${JSON.stringify(roundData)}`);
  // Chainlink price feeds return prices with 8 decimals
  const priceWith8Decimals = roundData.answer;
  const priceAsNumber = Number(ethers.utils.formatUnits(priceWith8Decimals, 8));
  Logger.info('getChainlinkPrice', `Current price: ${priceAsNumber}`);
  return priceAsNumber;
}

async function getBinancePrice(symbol: string): Promise<number | null> {
  Logger.debug('getBinancePrice', `Fetching Binance price for symbol: ${symbol}`);

  // Special handling for WETH
  if (symbol === 'WETH' || symbol === 'WBTC') {
    symbol = symbol.replace('W', '');
  }

  try {
    const url = `${BINANCE_API_URL}/ticker/price?symbol=${symbol}USD`;
    Logger.debug('getBinancePrice', `Making request to: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      Logger.info('getBinancePrice', `No Binance price available for ${symbol}`);
      return null;
    }

    const data = await response.json();
    Logger.debug('getBinancePrice', `Binance response: ${JSON.stringify(data)}`);
    Logger.info('getBinancePrice', `Current price for ${symbol}: ${data.price}`);

    return parseFloat(data.price);
  } catch (error) {
    Logger.info('getBinancePrice', `Could not fetch Binance price for ${symbol}`);
    Logger.debug('getBinancePrice', `Error details: ${JSON.stringify(error)}`);
    return null;
  }
}

function calculateFeeInToken(
  feeInCents: ethers.BigNumber,
  tokenDecimals: number,
  tokenPrice: number
): ethers.BigNumber {
  Logger.debug(
    'calculateFeeInToken',
    `Calculating fee. Fee in cents: ${feeInCents.toString()}, Decimals: ${tokenDecimals}, Token price: ${tokenPrice}`
  );

  // Convert dollar cents to dollars (divide by 100)
  // Then multiply by token decimals to get the proper token amount
  // Then divide by token price to convert to token units
  const fee = feeInCents
    .mul(ethers.BigNumber.from(10).pow(tokenDecimals))
    .div(100) // convert cents to dollars
    .div(ethers.BigNumber.from(Math.floor(tokenPrice * 1e6))) // divide by price (with 6 decimals precision)
    .mul(1e6); // adjust for the precision we added to price

  Logger.debug('calculateFeeInToken', `Calculated fee in token: ${fee.toString()}`);
  return fee;
}

function calculateExpectedOutput(
  swapAmount: ethers.BigNumber,
  priceIn: number,
  priceOut: number,
  decimalsIn: number,
  decimalsOut: number
): ethers.BigNumber {
  Logger.debug(
    'calculateExpectedOutput',
    `Calculating expected output. Swap amount: ${swapAmount.toString()}, ` +
      `Price in: ${priceIn}, Price out: ${priceOut}, ` +
      `Decimals in: ${decimalsIn}, Decimals out: ${decimalsOut}`
  );

  // Add validation to prevent division by zero
  if (priceOut === 0) {
    Logger.error('calculateExpectedOutput', 'Output token price cannot be zero');
    throw new Error('Output token price cannot be zero');
  }

  // 1. Convert swap amount to USD value (considering decimals)
  const valueInUsd = swapAmount
    .mul(ethers.BigNumber.from(Math.floor(priceIn * 1e6)))
    .div(ethers.BigNumber.from(10).pow(decimalsIn))
    .div(1e6);

  // 2. Convert USD value to output token amount with proper decimals
  // Ensure priceOut is converted to BigNumber with sufficient precision
  const priceOutBN = ethers.BigNumber.from(Math.floor(priceOut * 1e6));
  const expectedOutput = valueInUsd
    .mul(ethers.BigNumber.from(10).pow(decimalsOut))
    .mul(1e6) // Adjust for price precision
    .div(priceOutBN);

  Logger.info('calculateExpectedOutput', `Expected output amount: ${expectedOutput.toString()}`);
  return expectedOutput;
}

async function checkAndApproveToken(
  networkConfig: IBlockchain,
  tokenIn: string,
  amountIn: ethers.BigNumber,
  setupContractsResult: SetupContractReturn,
  erc20ABI: ContractInterface,
  chatterPayContract: ethers.Contract,
  entryPointContract: ethers.Contract
): Promise<string | null> {
  const tokenContract = new ethers.Contract(tokenIn, erc20ABI, setupContractsResult.provider);
  const { routerAddress } = networkConfig.contracts;

  Logger.debug(
    'checkAndApproveToken',
    `Checking allowance for token ${tokenIn}, and swap router ${routerAddress}`
  );

  // Check current allowance
  const currentAllowance = await tokenContract.allowance(
    setupContractsResult.proxy.proxyAddress,
    routerAddress
  );
  Logger.debug('checkAndApproveToken', `Current allowance: ${currentAllowance.toString()}`);

  if (currentAllowance.lt(amountIn)) {
    Logger.info('checkAndApproveToken', 'Insufficient allowance, approving...');

    // Create approve call data
    const approveCallData = chatterPayContract.interface.encodeFunctionData('approveToken', [
      tokenIn,
      ethers.constants.MaxUint256 // Approve maximum amount
    ]);

    // Execute approve operation
    try {
      const userOpGasConfig = networkConfig.gas.operations.swap;
      const approveTransactionResult: ExecueTransactionResult = await executeUserOperationWithRetry(
        networkConfig,
        setupContractsResult.provider,
        setupContractsResult.signer,
        setupContractsResult.backendSigner,
        entryPointContract,
        approveCallData,
        setupContractsResult.proxy.proxyAddress,
        'swap',
        userOpGasConfig.perGasInitialMultiplier,
        userOpGasConfig.perGasIncrement,
        userOpGasConfig.callDataInitialMultiplier,
        userOpGasConfig.maxRetries,
        userOpGasConfig.timeoutMsBetweenRetries
      );

      if (!approveTransactionResult.success) {
        throw new Error(approveTransactionResult.error);
      }

      Logger.info(
        'checkAndApproveToken',
        `Token approved successfully. Hash: ${approveTransactionResult.transactionHash}`
      );
      return approveTransactionResult.transactionHash;
    } catch (error) {
      Logger.error(
        'checkAndApproveToken',
        `Approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      throw error;
    }
  }

  Logger.info('checkAndApproveToken', 'Token already has sufficient allowance');
  return null;
}

/**
 * Executes a token swap with price checks and slippage protection
 */
export async function executeSwap(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  tokenAddresses: TokenAddresses,
  blockchainTokens: IToken[],
  amount: string,
  recipient: string
): Promise<ExecuteSwapResult> {
  Logger.info('executeSwap', `Starting swap execution. Amount: ${amount}, Recipient: ${recipient}`);
  Logger.debug('executeSwap', `Token addresses: ${JSON.stringify(tokenAddresses)}`);

  try {
    Logger.debug('executeSwap', 'Fetching contract ABIs');

    // In test environments we should not consider token price as we are using test pools
    const { environment } = networkConfig;
    const isTestNetwork = environment === 'TEST';

    const abisToFetch = [getChatterpayABI(), getERC20ABI()];

    if (!isTestNetwork) {
      abisToFetch.push(getChainlinkPriceFeedABI());
    }

    const [chatterpayABI, erc20ABI, ...otherABIs] = await Promise.all(abisToFetch);
    const priceFeedABI = isTestNetwork ? null : otherABIs[0];
    Logger.debug('executeSwap', 'ABIs fetched successfully');

    // Initialize ChatterPay contract
    const chatterPayContract = new ethers.Contract(
      networkConfig.contracts.chatterPayAddress,
      chatterpayABI,
      setupContractsResult.provider
    );
    Logger.info(
      'executeSwap',
      `ChatterPay contract initialized at ${networkConfig.contracts.chatterPayAddress}`
    );

    const { tokenAddressInput: tokenIn, tokenAddressOutput: tokenOut } = tokenAddresses;

    Logger.debug('executeSwap', 'Fetching token details');
    Logger.debug(
      'executeSwap',
      `ABIs first lines ERC20: ${JSON.stringify(erc20ABI).slice(0, 100)}, PriceFeed: ${priceFeedABI ? JSON.stringify(priceFeedABI).slice(0, 100) : 'Not loaded in test env'}`
    );
    const [tokenInDecimals, tokenOutDecimals, tokenInSymbol, tokenOutSymbol, feeInCents] =
      await Promise.all([
        getTokenDecimals(tokenIn, erc20ABI, setupContractsResult.provider),
        getTokenDecimals(tokenOut, erc20ABI, setupContractsResult.provider),
        getTokenSymbol(tokenIn, erc20ABI, setupContractsResult.provider),
        getTokenSymbol(tokenOut, erc20ABI, setupContractsResult.provider),
        chatterPayContract.getFeeInCents()
      ]);

    const tokenInfo = getTokenInfo(networkConfig, blockchainTokens, tokenOut);

    Logger.info(
      'executeSwap',
      `Token details - Input: ${tokenInSymbol} (${tokenInDecimals} decimals), Output: ${tokenOutSymbol} (${tokenOutDecimals} decimals, type: ${tokenInfo?.type})`
    );
    Logger.debug('executeSwap', `Fee in cents: ${feeInCents.toString()}`);

    let effectivePriceIn = 1;
    let effectivePriceOut = 5;

    // Keep Paymater Deposit Value
    const paymasterDepositValuePrev = await getPaymasterEntryPointDepositValue(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!
    );

    if (!isTestNetwork && priceFeedABI) {
      // Get price feeds and current prices
      Logger.debug('executeSwap', 'Fetching price feeds');
      const [tokenInFeed, tokenOutFeed] = await Promise.all([
        chatterPayContract.getPriceFeed(tokenIn),
        chatterPayContract.getPriceFeed(tokenOut)
      ]);

      Logger.debug('executeSwap', 'Fetching current prices from Chainlink');
      const [chainlinkPriceIn, chainlinkPriceOut] = await Promise.all([
        getChainlinkPrice(tokenInFeed, priceFeedABI, setupContractsResult.provider),
        getChainlinkPrice(tokenOutFeed, priceFeedABI, setupContractsResult.provider)
      ]);

      Logger.debug('executeSwap', 'Fetching current prices from Binance');
      const [binancePriceIn, binancePriceOut] = await Promise.all([
        getBinancePrice(tokenInSymbol),
        getBinancePrice(tokenOutSymbol)
      ]);

      Logger.info(
        'executeSwap',
        `Prices - Input: Chainlink ${chainlinkPriceIn}, Binance ${binancePriceIn}`
      );
      Logger.info(
        'executeSwap',
        `Prices - Output: Chainlink ${chainlinkPriceOut}, Binance ${binancePriceOut}`
      );

      // Use the lower price for output token for safety
      effectivePriceOut = !binancePriceOut
        ? chainlinkPriceOut
        : Math.min(chainlinkPriceOut, binancePriceOut);

      // Use the higher price for input token for safety
      effectivePriceIn = !binancePriceIn
        ? chainlinkPriceIn
        : Math.max(chainlinkPriceIn, binancePriceIn);

      Logger.info(
        'executeSwap',
        `Using effective prices - In: ${effectivePriceIn}, Out: ${effectivePriceOut}`
      );
    } else {
      Logger.info(
        'executeSwap',
        'Test environment detected - using price ratio with high slippage'
      );
    }

    // Calculate fee and amounts
    const feeInTokenIn = calculateFeeInToken(feeInCents, tokenInDecimals, effectivePriceIn);
    Logger.debug('executeSwap', `Fee in input token: ${feeInTokenIn.toString()}`);

    const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
    const swapAmount = amountInBN.sub(feeInTokenIn);
    Logger.info('executeSwap', `Swap amount after fee: ${swapAmount.toString()}`);

    // Calculate expected output with price adjustment
    const expectedOutput = calculateExpectedOutput(
      swapAmount,
      effectivePriceIn,
      effectivePriceOut,
      tokenInDecimals,
      tokenOutDecimals
    );
    Logger.info('executeSwap', `Expected output amount: ${expectedOutput.toString()}`);

    const isOutStable = tokenInfo?.type === 'stable';

    // Determine and apply slippage
    const baseSlippage = await determineSlippage(
      chatterPayContract,
      tokenOutSymbol,
      isOutStable,
      tokenOut
    );
    const totalSlippage = baseSlippage + SLIPPAGE_CONFIG.EXTRA;
    Logger.info('executeSwap', `Total slippage: ${totalSlippage} bps`);

    const amountOutMin = expectedOutput.mul(10000 - totalSlippage).div(10000);
    Logger.info('executeSwap', `Minimum output amount: ${amountOutMin.toString()}`);

    // Check token allowance and approves the max if needed
    const approveTrxHash = await checkAndApproveToken(
      networkConfig,
      tokenIn,
      amountInBN,
      setupContractsResult,
      erc20ABI,
      chatterPayContract,
      entryPointContract
    );

    // Execute the swap
    Logger.debug('executeSwap', 'Creating swap call data');
    const swapCallData = createSwapCallData(
      chatterPayContract,
      tokenIn,
      tokenOut,
      amountInBN,
      amountOutMin,
      recipient
    );

    Logger.info('executeSwap', 'Executing swap operation');
    const userOpGasConfig = networkConfig.gas.operations.swap;
    const swapTransactionResult: ExecueTransactionResult = await executeUserOperationWithRetry(
      networkConfig,
      setupContractsResult.provider,
      setupContractsResult.signer,
      setupContractsResult.backendSigner,
      entryPointContract,
      swapCallData,
      setupContractsResult.proxy.proxyAddress,
      'swap',
      userOpGasConfig.perGasInitialMultiplier,
      userOpGasConfig.perGasIncrement,
      userOpGasConfig.callDataInitialMultiplier,
      userOpGasConfig.maxRetries,
      userOpGasConfig.timeoutMsBetweenRetries
    );

    if (!swapTransactionResult.success) {
      throw new Error(swapTransactionResult.error);
    }

    await logPaymasterEntryPointDeposit(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!,
      paymasterDepositValuePrev
    );

    Logger.info(
      'executeSwap',
      `Swap completed successfully. Hash: ${swapTransactionResult.transactionHash}`
    );
    return {
      success: true,
      approveTransactionHash: approveTrxHash || '',
      swapTransactionHash: swapTransactionResult.transactionHash
    };
  } catch (error) {
    Logger.error(
      'executeSwap',
      `Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return { success: false, swapTransactionHash: '', approveTransactionHash: '' };
  }
}
