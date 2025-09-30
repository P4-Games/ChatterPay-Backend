import { ethers, ContractInterface } from 'ethers';

import { IToken } from '../models/tokenModel';
import { gasService } from './web3/gasService';
import { Logger } from '../helpers/loggerHelper';
import { getTokenInfo } from './blockchainService';
import { IBlockchain } from '../models/blockchainModel';
import { getTokenSymbol, getTokenDecimals } from './commonService';
import { executeUserOperationWithRetry } from './web3/userOpService';
import {
  logPaymasterEntryPointDeposit,
  getPaymasterEntryPointDepositValue
} from './web3/paymasterService';
import {
  getERC20ABI,
  getChatterpayABI,
  getUniswapQuoterV2ABI,
  getChainlinkPriceFeedABI
} from './web3/abiService';
import {
  swapTokensData,
  ExecuteSwapResult,
  SetupContractReturn,
  ExecueTransactionResult
} from '../types/commonType';
import {
  BINANCE_API_URL,
  SWAP_USE_QUOTER,
  SWAP_ZERO_FEE_MODE,
  SWAP_EXECUTE_SIMPLE,
  SWAP_SLIPPAGE_CONFIG_EXTRA,
  SWAP_SLIPPAGE_CONFIG_STABLE,
  SWAP_SLIPPAGE_CONFIG_DEFAULT,
  SWAP_PRICE_THRESHOLD_PERCENT
} from '../config/constants';

const SLIPPAGE_CONFIG = {
  STABLE: SWAP_SLIPPAGE_CONFIG_STABLE,
  DEFAULT: SWAP_SLIPPAGE_CONFIG_DEFAULT,
  EXTRA: SWAP_SLIPPAGE_CONFIG_EXTRA
} as const;

type QuoteSingleParams = {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient?: string;
  amountIn: ethers.BigNumber;
  sqrtPriceLimitX96?: ethers.BigNumber;
};

type ValidateSwapResult = {
  result: boolean;
  abis: {
    chatterpayABI: ContractInterface;
    erc20ABI: ContractInterface;
  };
  tokenDetails?: {
    tokenInDecimals: number;
    tokenOutDecimals: number;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    feeInCents: ethers.BigNumber;
  };
  amountInBN?: ethers.BigNumber;
  tokenInfoOut?: IToken | undefined;
  baseSlippage?: number;
  amountOutMin?: ethers.BigNumber;
  errors?: string[];
};

/**
 * Fetches the minimum output amount from Uniswap V3 Quoter with slippage calculation
 *
 * Retrieves a price quote from Uniswap V3 Quoter contract and calculates the minimum
 * acceptable output amount based on the specified slippage tolerance. Primarily uses
 * Quoter V2 but handles provider/signer compatibility automatically.
 *
 * @param provider - Ethers provider or signer instance for blockchain interaction
 * @param quoterAddress - Ethereum address of the Uniswap V3 Quoter contract
 * @param params - Quote parameters including tokens, fee tier, and input amount
 * @param slippageBps - Slippage tolerance in basis points (e.g., 50 = 0.5%)
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing both the quoted output amount and minimum output with slippage
 * @throws Error if parameters are invalid, quote fails, or returns zero amount
 *
 * @example
 * const { amountOut, amountOutMin } = await getAmountOutMinViaQuoter({
 *   provider,
 *   quoterAddress: '0x...',
 *   params: {
 *     tokenIn: usdcAddress,
 *     tokenOut: wethAddress,
 *     fee: 3000,
 *     amountIn: ethers.utils.parseUnits('1000', 6)
 *   },
 *   slippageBps: 50,
 *   logKey: 'swap-123'
 * });
 */
async function getAmountOutMinViaQuoter({
  provider,
  quoterAddress,
  params,
  slippageBps,
  logKey
}: {
  provider: ethers.providers.Provider | ethers.Signer;
  quoterAddress: string;
  params: QuoteSingleParams;
  slippageBps: number;
  logKey: string;
}): Promise<{ amountOut: ethers.BigNumber; amountOutMin: ethers.BigNumber }> {
  Logger.debug('getAmountOutMinViaQuoter', logKey, 'Fetching quote from Uniswap');

  // Get the provider from signer if needed
  const providerToUse = ethers.Signer.isSigner(provider) ? provider.provider! : provider;

  const ZERO = ethers.BigNumber.from(0);
  const ONE_BPS = ethers.BigNumber.from(10_000);

  if (!quoterAddress) throw new Error('Missing quoterAddress');
  if (!params?.tokenIn || !params?.tokenOut) throw new Error('Missing token addresses');
  if (!params?.fee) throw new Error('Missing fee tier');
  if (!params?.amountIn || params.amountIn.lte(0)) throw new Error('amountIn must be > 0');
  if (slippageBps < 0 || slippageBps >= 10_000)
    throw new Error('slippageBps must be in [0, 10000)');

  const sqrtPriceLimit = params.sqrtPriceLimitX96 ?? ZERO;

  try {
    // Try Quoter V2 first
    const quoterV2ABI = await getUniswapQuoterV2ABI();
    const quoterV2 = new ethers.Contract(quoterAddress, quoterV2ABI, providerToUse);
    const v2Params = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.fee,
      recipient: params.recipient ?? ethers.constants.AddressZero,
      amountIn: params.amountIn,
      sqrtPriceLimitX96: sqrtPriceLimit
    };

    Logger.debug('getAmountOutMinViaQuoter', logKey, 'Attempting V2 quote...');
    const quote = await quoterV2.callStatic.quoteExactInputSingle(v2Params);
    const { amountOut } = quote;

    if (amountOut.lte(0)) throw new Error('QuoterV2 returned zero amountOut');

    const slip = ONE_BPS.sub(ethers.BigNumber.from(slippageBps));
    const amountOutMin = amountOut.mul(slip).div(ONE_BPS);

    Logger.debug(
      'getAmountOutMinViaQuoter',
      logKey,
      `Quote V2 success - amountOut: ${amountOut.toString()}`
    );
    return { amountOut, amountOutMin };
  } catch (eV2) {
    Logger.debug('getAmountOutMinViaQuoter', logKey, `V2 failed with error: ${eV2}`);
    throw new Error(`Failed to get quote: ${eV2}`);
  }
}

/**
 * Creates encoded call data for executing a token swap on the ChatterPay contract
 *
 * Generates the properly encoded function call data for the executeSwap function
 * using the Ethereum ABI encoding standards. This encoded data can be used directly
 * in transactions sent to the ChatterPay contract.
 *
 * @param chatterPayContract - Initialized ChatterPay contract instance with ABI
 * @param tokenIn - Address of the input token to be swapped
 * @param tokenOut - Address of the output token to receive
 * @param amountIn - Amount of input tokens to swap (in wei/smallest units)
 * @param amountOutMin - Minimum amount of output tokens to accept (in wei/smallest units)
 * @param recipient - Address that will receive the swapped tokens
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Hex string containing the ABI-encoded function call data
 *
 * @example
 * const callData = createSwapCallData(
 *   chatterPayContract,
 *   usdcAddress,
 *   wethAddress,
 *   ethers.utils.parseUnits('100', 6),
 *   ethers.utils.parseUnits('0.05', 18),
 *   userAddress,
 *   'swap-123'
 * );
 */
function createSwapCallData(
  chatterPayContract: ethers.Contract,
  tokenIn: string,
  tokenOut: string,
  amountIn: ethers.BigNumber,
  amountOutMin: ethers.BigNumber,
  recipient: string,
  logKey: string
): string {
  Logger.debug(
    'createSwapCallData',
    logKey,
    `Creating swap call data. TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountIn.toString()}, AmountOutMin: ${amountOutMin.toString()}, Recipient: ${recipient}`
  );

  const swapEncode = chatterPayContract.interface.encodeFunctionData('executeSwap', [
    tokenIn,
    tokenOut,
    amountIn,
    amountOutMin,
    recipient
  ]);

  Logger.debug('createSwapCallData', logKey, `Generated swap encode: ${swapEncode}`);
  return swapEncode;
}

/**
 * Determines the appropriate slippage tolerance for a swap operation
 *
 * Checks for custom slippage settings configured in the ChatterPay contract first,
 * then falls back to default slippage values based on token type (stablecoin or volatile).
 * Custom slippage takes precedence over automatic token-based slippage calculation.
 *
 * @param chatterPayContract - Initialized ChatterPay contract instance
 * @param tokenSymbol - Symbol of the output token for identification in logs
 * @param isStable - Boolean indicating if the output token is a stablecoin
 * @param tokenOut - Address of the output token to check for custom slippage
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Slippage tolerance in basis points (e.g., 50 = 0.5%)
 *
 * @example
 * const slippage = await determineSlippage(
 *   chatterPayContract,
 *   'USDC',
 *   true,
 *   usdcAddress,
 *   'swap-123'
 * );
 */
async function determineSlippage(
  chatterPayContract: ethers.Contract,
  tokenSymbol: string,
  isStable: boolean,
  tokenOut: string,
  logKey: string
): Promise<number> {
  Logger.debug('determineSlippage', logKey, `Determining slippage for token ${tokenSymbol}`);

  const customSlippage = await chatterPayContract.getCustomSlippage(tokenOut);
  Logger.debug('determineSlippage', logKey, `Custom slippage: ${customSlippage.toString()}`);

  if (customSlippage.gt(0)) {
    Logger.info('determineSlippage', logKey, `Using custom slippage: ${customSlippage.toString()}`);
    return customSlippage.toNumber();
  }

  if (isStable) {
    Logger.info(
      'determineSlippage',
      logKey,
      `Using stable token slippage (${SLIPPAGE_CONFIG.STABLE}) for ${tokenSymbol}`
    );
    return SLIPPAGE_CONFIG.STABLE;
  }

  Logger.info(
    'determineSlippage',
    logKey,
    `Using default slippage (${SLIPPAGE_CONFIG.DEFAULT}) for ${tokenSymbol}`
  );
  return SLIPPAGE_CONFIG.DEFAULT;
}

/**
 * Fetches the current price from a Chainlink price feed contract
 *
 * Queries a Chainlink price feed contract on-chain to retrieve the latest
 * price data. Chainlink prices are returned with 8 decimal precision and
 * are converted to a JavaScript number for easy consumption.
 *
 * @param priceFeedAddress - Ethereum address of the Chainlink price feed contract
 * @param priceFeedABI - ABI interface for the Chainlink price feed contract
 * @param provider - Ethers provider instance for blockchain interaction
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Current price as a JavaScript number
 *
 * @example
 * const ethPrice = await getChainlinkPrice(
 *   '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', // ETH/USD feed
 *   chainlinkABI,
 *   provider,
 *   'price-check-123'
 * );
 */
async function getChainlinkPrice(
  priceFeedAddress: string,
  priceFeedABI: ContractInterface,
  provider: ethers.providers.Provider,
  logKey: string
): Promise<number> {
  Logger.debug(
    'getChainlinkPrice',
    logKey,
    `Fetching Chainlink price from feed: ${priceFeedAddress}`
  );
  const priceFeed = new ethers.Contract(priceFeedAddress, priceFeedABI, provider);
  const roundData = await priceFeed.latestRoundData();
  Logger.debug('getChainlinkPrice', logKey, `Latest round data: ${JSON.stringify(roundData)}`);
  // Chainlink price feeds return prices with 8 decimals
  const priceWith8Decimals = roundData.answer;
  const priceAsNumber = Number(ethers.utils.formatUnits(priceWith8Decimals, 8));
  Logger.info('getChainlinkPrice', logKey, `Current price: ${priceAsNumber}`);
  return priceAsNumber;
}

/**
 * Fetches the current price of a cryptocurrency from Binance API
 *
 * Retrieves the latest USD price for a given cryptocurrency symbol from Binance's
 * public API. Handles special cases for wrapped tokens (WETH, WBTC) by converting
 * them to their underlying symbols. Returns null if the symbol is not available
 * or if the API request fails.
 *
 * @param symbol - Cryptocurrency symbol (e.g., 'ETH', 'BTC', 'WETH', 'WBTC')
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Current price in USD as a number, or null if unavailable
 *
 * @example
 * const ethPrice = await getBinancePrice('ETH', 'price-check-123');
 * const btcPrice = await getBinancePrice('WBTC', 'price-check-456'); // Automatically converts to BTC
 */
async function getBinancePrice(symbol: string, logKey: string): Promise<number | null> {
  Logger.debug('getBinancePrice', logKey, `Fetching Binance price for symbol: ${symbol}`);

  // Special handling for WETH
  if (symbol === 'WETH' || symbol === 'WBTC') {
    symbol = symbol.replace('W', '');
  }

  try {
    const url = `${BINANCE_API_URL}/ticker/price?symbol=${symbol}USD`;
    Logger.debug('getBinancePrice', logKey, `Making request to: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      Logger.info('getBinancePrice', logKey, `No Binance price available for ${symbol}`);
      return null;
    }

    const data = await response.json();
    Logger.debug('getBinancePrice', logKey, `Binance response: ${JSON.stringify(data)}`);
    Logger.info('getBinancePrice', logKey, `Current price for ${symbol}: ${data.price}`);

    return parseFloat(data.price);
  } catch (error) {
    Logger.info('getBinancePrice', logKey, `Could not fetch Binance price for ${symbol}`);
    Logger.debug('getBinancePrice', logKey, `Error details: ${JSON.stringify(error)}`);
    return null;
  }
}

/**
 * Calculates the equivalent fee amount in token units based on USD cents
 *
 * Converts a fee amount specified in USD cents to the equivalent amount
 * of a specific token using the token's current price. Handles decimal
 * precision and currency conversion with fixed-point arithmetic.
 *
 * @param feeInCents - Fee amount in USD cents (e.g., 100 cents = $1.00)
 * @param tokenDecimals - Number of decimals for the target token
 * @param tokenPrice - Current price of the token in USD
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Fee amount in token units (wei/smallest units) equivalent to the USD cents input
 *
 * @example
 * const feeInToken = calculateFeeInToken(
 *   ethers.BigNumber.from(50), // 50 cents = $0.50
 *   18,                        // ETH decimals
 *   3000.0,                    // ETH price = $3000
 *   'fee-calculation-123'
 * );
 */
function calculateFeeInToken(
  feeInCents: ethers.BigNumber,
  tokenDecimals: number,
  tokenPrice: number,
  logKey: string
): ethers.BigNumber {
  Logger.debug(
    'calculateFeeInToken',
    logKey,
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

  Logger.debug('calculateFeeInToken', logKey, `Calculated fee in token: ${fee.toString()}`);
  return fee;
}

/**
 * Calculates the expected output amount for a token swap based on price feeds
 *
 * Computes the expected output amount using the input token amount and the
 * current prices of both tokens. Handles decimal normalization between tokens
 * with different decimal precision and uses fixed-point arithmetic to maintain
 * precision during calculations.
 *
 * @param swapAmount - Input token amount in wei (smallest units)
 * @param priceIn - Current price of the input token (USD or other base currency)
 * @param priceOut - Current price of the output token (USD or other base currency)
 * @param decimalsIn - Number of decimals for the input token
 * @param decimalsOut - Number of decimals for the output token
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Expected output amount in wei (smallest units of output token)
 * @throws Error if input or output prices are invalid (<= 0)
 *
 * @example
 * const expectedOutput = calculateExpectedOutput(
 *   ethers.utils.parseUnits('100', 6), // 100 USDT (6 decimals)
 *   1.0,   // USDT price
 *   3000.0, // ETH price
 *   6,     // USDT decimals
 *   18,    // ETH decimals
 *   'swap-123'
 * );
 */
function calculateExpectedOutput(
  swapAmount: ethers.BigNumber,
  priceIn: number,
  priceOut: number,
  decimalsIn: number,
  decimalsOut: number,
  logKey: string
): ethers.BigNumber {
  Logger.debug(
    'calculateExpectedOutput',
    logKey,
    `Calculating expected output. Swap amount: ${swapAmount.toString()}, ` +
      `Price in: ${priceIn}, Price out: ${priceOut}, ` +
      `Decimals in: ${decimalsIn}, Decimals out: ${decimalsOut}`
  );

  if (priceIn <= 0) throw new Error('Input token price must be > 0');
  if (priceOut <= 0) throw new Error('Output token price must be > 0');
  if (swapAmount.lte(0)) return ethers.BigNumber.from(0);

  // Use a fixed scale for prices to keep precision without overflow
  const PRICE_SCALE = 12; // 1e12 is plenty
  const pIn = ethers.utils.parseUnits(priceIn.toString(), PRICE_SCALE); // BigNumber
  const pOut = ethers.utils.parseUnits(priceOut.toString(), PRICE_SCALE); // BigNumber

  // Normalize amount to the output token decimals: amountNorm = amountIn * 10^(decOut-decIn)
  let amountNorm = swapAmount;
  if (decimalsIn > decimalsOut) {
    amountNorm = amountNorm.div(ethers.BigNumber.from(10).pow(decimalsIn - decimalsOut));
  } else if (decimalsOut > decimalsIn) {
    amountNorm = amountNorm.mul(ethers.BigNumber.from(10).pow(decimalsOut - decimalsIn));
  }

  // expectedOut = amountNorm * (priceIn / priceOut)
  // Do multiplication first to preserve precision; division happens once at the end.
  const expectedOut = amountNorm.mul(pIn).div(pOut);

  Logger.info(
    'calculateExpectedOutput',
    logKey,
    `Expected output amount: ${expectedOut.toString()}`
  );
  return expectedOut;
}

/**
 * Ensures the transaction signer has sufficient native currency for gas costs
 *
 * Checks the current balance of the signer address and calculates the required gas cost
 * based on gas limit and gas price. If insufficient funds are detected, automatically
 * transfers the required amount plus a buffer from the backend signer to the transaction signer.
 * Supports both legacy and EIP-1559 fee models.
 *
 * @param provider - Ethers provider instance for blockchain interaction
 * @param backendSigner - Backend signer instance that holds the native currency for funding
 * @param signerAddress - Address of the transaction signer that needs gas funding
 * @param gasLimit - Estimated gas limit for the transaction
 * @param gasPrice - Gas price for legacy transactions (optional if using EIP-1559)
 * @param maxFeePerGas - Max fee per gas for EIP-1559 transactions (optional if using legacy)
 * @param bufferBps - Buffer percentage in basis points (500 = 5%) to add to the required amount
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object indicating whether a top-up was performed and the transaction hash if so
 * @throws Error if gas parameters are missing or if the top-up transaction fails
 *
 * @example
 * const result = await ensureRecipientHasGas({
 *   provider,
 *   backendSigner,
 *   signerAddress: '0x...',
 *   gasLimit: estimatedGas,
 *   gasPrice,
 *   bufferBps: 1000, // 10% buffer
 *   logKey: 'swap-123'
 * });
 */
export async function ensureRecipientHasGas({
  provider,
  backendSigner,
  signerAddress,
  gasLimit,
  gasPrice, // optional if using legacy mode
  maxFeePerGas, // optional if using EIP-1559
  bufferBps = 500, // 500 = 5% buffer
  logKey = ''
}: {
  provider: ethers.providers.Provider;
  backendSigner: ethers.Signer;
  signerAddress: string;
  gasLimit: ethers.BigNumber;
  gasPrice?: ethers.BigNumber;
  maxFeePerGas?: ethers.BigNumber;
  bufferBps?: number;
  logKey?: string;
}): Promise<{ toppedUp: boolean; topUpTxHash?: string }> {
  // Use the upper bound cost depending on fee model
  const perUnitGas = maxFeePerGas ?? gasPrice;
  if (!perUnitGas) {
    throw new Error('ensureRecipientHasGas: missing gasPrice or maxFeePerGas');
  }

  const requiredWei = gasLimit.mul(perUnitGas);
  const currentBal = await provider.getBalance(signerAddress);

  Logger.debug(
    'ensureRecipientHasGas',
    logKey,
    `Recipient(signer) ${signerAddress} balance=${ethers.utils.formatEther(currentBal)} ETH; required=${ethers.utils.formatEther(requiredWei)} ETH`
  );

  if (currentBal.gte(requiredWei)) {
    Logger.debug('ensureRecipientHasGas', logKey, 'Sufficient balance; no top-up needed');
    return { toppedUp: false };
  }

  const shortfall = requiredWei.sub(currentBal);
  const topUp = shortfall.mul(10000 + bufferBps).div(10000);

  Logger.info(
    'ensureRecipientHasGas',
    logKey,
    `Top-up required: ${ethers.utils.formatEther(topUp)} ETH (shortfall ${ethers.utils.formatEther(shortfall)})`
  );

  const topUpTx = await backendSigner.sendTransaction({ to: signerAddress, value: topUp });
  const r = await topUpTx.wait();

  if (!r || r.status !== 1) {
    throw new Error(`ensureRecipientHasGas: top-up failed tx=${topUpTx.hash}`);
  }

  Logger.debug(
    'ensureRecipientHasGas',
    logKey,
    `Top-up confirmed: ${topUpTx.hash}, form backend-Signer ${await backendSigner.getAddress()} `
  );
  return { toppedUp: true, topUpTxHash: topUpTx.hash };
}

/**
 * Handles token approval for direct EOA transactions (non-UserOperation flow)
 *
 * Checks the current token allowance for the swap router and executes an approval transaction
 * if insufficient. Uses direct EOA transactions with gas funding from backend signer.
 * Ensures the transaction signer has sufficient ETH for gas costs before proceeding.
 *
 * @param networkConfig - Blockchain network configuration containing contract addresses
 * @param setupContractsResult - Setup results with provider, signer, and backend signer instances
 * @param tokenIn - Address of the input token to be approved
 * @param recipient - Proxy contract address that holds the tokens (approval owner)
 * @param amountInBN - Required token amount for swap in BigNumber format (wei)
 * @param chatterPayContract - Initialized ChatterPay proxy contract instance
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Transaction hash of the approval if executed, empty string if allowance was sufficient
 * @throws Error if gas estimation fails or transaction execution fails
 *
 * @example
 * const approvalTxHash = await handleTokenApproval(
 *   networkConfig,
 *   setupResult,
 *   usdtAddress,
 *   proxyAddress,
 *   amount,
 *   chatterPayContract,
 *   'swap-123'
 * );
 */
async function handleTokenApproval(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  tokenIn: string,
  recipient: string,
  amountInBN: ethers.BigNumber,
  chatterPayContract: ethers.Contract,
  logKey: string
): Promise<string> {
  const { provider, userPrincipal: signer, backPrincipal: backendSigner } = setupContractsResult;
  const { erc20ABI } = await fetchRequiredABIs();
  const { routerAddress } = networkConfig.contracts;

  Logger.debug(
    'handleTokenApproval',
    logKey,
    `Checking allowance for token ${tokenIn}, router ${routerAddress}`
  );

  const tokenContract = new ethers.Contract(tokenIn, erc20ABI, provider);
  const currentAllowance = await tokenContract.allowance(recipient, routerAddress);

  Logger.debug('handleTokenApproval', logKey, `Current allowance: ${currentAllowance.toString()}`);

  if (currentAllowance.lt(amountInBN)) {
    Logger.info('handleTokenApproval', logKey, 'Insufficient allowance, approving...');

    const approveCallData = chatterPayContract.interface.encodeFunctionData('approveToken', [
      tokenIn,
      ethers.constants.MaxUint256
    ]);

    let approveGasLimit: ethers.BigNumber;
    try {
      approveGasLimit = await chatterPayContract.estimateGas.approveToken(
        tokenIn,
        ethers.constants.MaxUint256,
        { from: await signer.getAddress() }
      );
      approveGasLimit = approveGasLimit.mul(120).div(100);
    } catch (error) {
      Logger.warn(
        'handleTokenApproval',
        logKey,
        `Approve gas estimation failed, using fallback: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      approveGasLimit = ethers.BigNumber.from('100000');
    }

    const feeData = await provider.getFeeData();
    const signerAddress = await signer.getAddress();

    // Ensure funds for the APPROVAL transaction
    await ensureRecipientHasGas({
      provider,
      backendSigner,
      signerAddress,
      gasLimit: approveGasLimit,
      gasPrice: feeData.gasPrice ?? undefined,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      bufferBps: 500,
      logKey
    });

    const gasPrice = feeData.gasPrice || (await provider.getGasPrice());
    const approveTx = await signer.sendTransaction({
      to: recipient,
      data: approveCallData,
      gasLimit: approveGasLimit,
      gasPrice
    });

    Logger.info('handleTokenApproval', logKey, `Approve transaction sent: ${approveTx.hash}`);

    const approveReceipt = await approveTx.wait();
    Logger.info(
      'handleTokenApproval',
      logKey,
      `Approve confirmed. Gas used: ${approveReceipt.gasUsed.toString()}`
    );

    return approveTx.hash;
  }

  Logger.info('handleTokenApproval', logKey, 'Token already has sufficient allowance');
  return '';
}

/**
 * Checks and approves token allowance for the swap router
 *
 * Verifies the current allowance of the token for the swap router and approves
 * the maximum amount if the current allowance is insufficient. Uses UserOperations
 * with EntryPoint for gasless transactions via the paymaster.
 *
 * @param networkConfig - Blockchain network configuration
 * @param tokenIn - Address of the input token to approve
 * @param amountIn - Amount of tokens needed for the swap (in wei)
 * @param setupContractsResult - Setup results containing provider, signer, and proxy information
 * @param erc20ABI - ERC20 token ABI interface
 * @param chatterPayContract - Initialized ChatterPay contract instance
 * @param entryPointContract - EntryPoint contract for UserOperation execution
 * @param logKey - Logging identifier for tracing operations
 *
 * @returns Transaction hash of the approval operation if executed, null if already sufficient allowance
 * @throws Error if approval operation fails
 *
 * @example
 * const approveHash = await checkAndApproveToken(
 *   networkConfig,
 *   tokenAddress,
 *   amount,
 *   setupResult,
 *   erc20ABI,
 *   chatterPayContract,
 *   entryPointContract,
 *   'swap-123'
 * );
 */
async function checkAndApproveToken(
  networkConfig: IBlockchain,
  tokenIn: string,
  amountIn: ethers.BigNumber,
  setupContractsResult: SetupContractReturn,
  erc20ABI: ContractInterface,
  chatterPayContract: ethers.Contract,
  entryPointContract: ethers.Contract,
  logKey: string
): Promise<string | null> {
  const tokenContract = new ethers.Contract(tokenIn, erc20ABI, setupContractsResult.provider);
  const { routerAddress } = networkConfig.contracts;

  Logger.debug(
    'checkAndApproveToken',
    logKey,
    `Checking allowance for token ${tokenIn}, and swap router ${routerAddress}`
  );

  // Check current allowance
  const currentAllowance = await tokenContract.allowance(
    setupContractsResult.proxy.proxyAddress,
    routerAddress
  );
  Logger.debug('checkAndApproveToken', logKey, `Current allowance: ${currentAllowance.toString()}`);

  if (currentAllowance.lt(amountIn)) {
    Logger.info('checkAndApproveToken', logKey, 'Insufficient allowance, approving...');

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
        setupContractsResult.userPrincipal,
        entryPointContract,
        approveCallData,
        setupContractsResult.proxy.proxyAddress,
        'swap',
        logKey,
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
        logKey,
        `Token approved successfully. Hash: ${approveTransactionResult.transactionHash}`
      );
      return approveTransactionResult.transactionHash;
    } catch (error) {
      Logger.error(
        'checkAndApproveToken',
        logKey,
        `Approval failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      throw error;
    }
  }

  Logger.info('checkAndApproveToken', logKey, 'Token already has sufficient allowance');
  return null;
}

/**
 * Fetches all required ABIs for contract interactions
 *
 * Asynchronously loads and returns the necessary contract ABIs for various operations
 * including ChatterPay contracts, ERC20 tokens, and Chainlink price feeds. Uses
 * parallel fetching for optimal performance.
 *
 * @returns Object containing all required ABIs:
 *   - chatterpayABI: ABI for ChatterPay contract interactions
 *   - erc20ABI: Standard ERC20 token interface ABI
 *   - priceFeedABI: Chainlink price feed contract ABI
 *
 * @example
 * const { chatterpayABI, erc20ABI, priceFeedABI } = await fetchRequiredABIs();
 */
async function fetchRequiredABIs() {
  Logger.debug('fetchRequiredABIs', 'Fetching contract ABIs');
  const abisToFetch = [getChatterpayABI(), getERC20ABI()];

  abisToFetch.push(getChainlinkPriceFeedABI());
  const [chatterpayABI, erc20ABI, ...otherABIs] = await Promise.all(abisToFetch);
  return {
    chatterpayABI,
    erc20ABI,
    priceFeedABI: otherABIs[0]
  };
}

/**
 * Fetches comprehensive details for both input and output tokens in a swap operation
 *
 * Retrieves token metadata including decimals, symbols, and fee information in parallel
 * for optimal performance. Combines on-chain data with contract-specific fee settings.
 *
 * @param tokenIn - Address of the input token
 * @param tokenOut - Address of the output token
 * @param erc20ABI - Standard ERC20 token interface ABI
 * @param provider - Ethers provider instance for blockchain interaction
 * @param chatterPayContract - Initialized ChatterPay contract instance for fee query
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing token details for both input and output tokens plus fee information
 *
 * @example
 * const tokenDetails = await fetchTokenDetails(
 *   usdcAddress,
 *   wethAddress,
 *   erc20ABI,
 *   provider,
 *   chatterPayContract,
 *   'swap-123'
 * );
 */
async function fetchTokenDetails(
  tokenIn: string,
  tokenOut: string,
  erc20ABI: ContractInterface,
  provider: ethers.providers.Provider,
  chatterPayContract: ethers.Contract,
  logKey: string
) {
  Logger.debug('fetchTokenDetails', logKey, 'Fetching token details');
  const [tokenInDecimals, tokenOutDecimals, tokenInSymbol, tokenOutSymbol, feeInCents] =
    await Promise.all([
      getTokenDecimals(tokenIn, erc20ABI, provider, logKey),
      getTokenDecimals(tokenOut, erc20ABI, provider, logKey),
      getTokenSymbol(tokenIn, erc20ABI, provider, logKey),
      getTokenSymbol(tokenOut, erc20ABI, provider, logKey),
      chatterPayContract.getFeeInCents()
    ]);

  return {
    tokenInDecimals,
    tokenOutDecimals,
    tokenInSymbol,
    tokenOutSymbol,
    feeInCents
  };
}

/**
 * Fetches and calculates effective prices for both input and output tokens
 *
 * Retrieves prices from multiple sources (Chainlink on-chain feeds and Binance API)
 * and calculates conservative effective prices for swap safety. Uses the higher price
 * for input tokens and lower price for output tokens to ensure worst-case scenario protection.
 *
 * @param tokenIn - Address of the input token
 * @param tokenOut - Address of the output token
 * @param tokenInSymbol - Symbol of the input token for API queries
 * @param tokenOutSymbol - Symbol of the output token for API queries
 * @param chatterPayContract - Initialized ChatterPay contract instance for price feed addresses
 * @param priceFeedABI - Chainlink price feed contract ABI
 * @param provider - Ethers provider instance for blockchain interaction
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing conservative effective prices for both tokens
 *
 * @example
 * const prices = await fetchTokenPrices(
 *   usdcAddress,
 *   wethAddress,
 *   'USDC',
 *   'WETH',
 *   chatterPayContract,
 *   priceFeedABI,
 *   provider,
 *   'swap-123'
 * );
 */
async function fetchTokenPrices(
  tokenIn: string,
  tokenOut: string,
  tokenInSymbol: string,
  tokenOutSymbol: string,
  chatterPayContract: ethers.Contract,
  priceFeedABI: ContractInterface,
  provider: ethers.providers.Provider,
  logKey: string
) {
  const [tokenInFeed, tokenOutFeed] = await Promise.all([
    chatterPayContract.getPriceFeed(tokenIn),
    chatterPayContract.getPriceFeed(tokenOut)
  ]);

  const [chainlinkPriceIn, chainlinkPriceOut] = await Promise.all([
    getChainlinkPrice(tokenInFeed, priceFeedABI, provider, logKey),
    getChainlinkPrice(tokenOutFeed, priceFeedABI, provider, logKey)
  ]);

  const [binancePriceIn, binancePriceOut] = await Promise.all([
    getBinancePrice(tokenInSymbol, logKey),
    getBinancePrice(tokenOutSymbol, logKey)
  ]);

  // Use the lower price for output token for safety
  const effectivePriceOut = !binancePriceOut
    ? chainlinkPriceOut
    : Math.min(chainlinkPriceOut, binancePriceOut);

  // Use the higher price for input token for safety
  const effectivePriceIn = !binancePriceIn
    ? chainlinkPriceIn
    : Math.max(chainlinkPriceIn, binancePriceIn);

  Logger.debug('fetchTokenPrices', logKey, `effectivePriceIn: ${effectivePriceIn}`);
  Logger.debug('fetchTokenPrices', logKey, `effectivePriceOut: ${effectivePriceOut}`);

  return { effectivePriceIn, effectivePriceOut };
}

/**
 * Fetches and calculates effective prices for both input and output tokens
 *
 * Retrieves prices from multiple sources (Chainlink on-chain feeds and Binance API)
 * and calculates conservative effective prices for swap safety. Uses the higher price
 * for input tokens and lower price for output tokens to ensure worst-case scenario protection.
 *
 * @param tokenIn - Address of the input token
 * @param tokenOut - Address of the output token
 * @param tokenInSymbol - Symbol of the input token for API queries
 * @param tokenOutSymbol - Symbol of the output token for API queries
 * @param chatterPayContract - Initialized ChatterPay contract instance for price feed addresses
 * @param priceFeedABI - Chainlink price feed contract ABI
 * @param provider - Ethers provider instance for blockchain interaction
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing conservative effective prices for both tokens
 *
 * @example
 * const prices = await fetchTokenPrices(
 *   usdcAddress,
 *   wethAddress,
 *   'USDC',
 *   'WETH',
 *   chatterPayContract,
 *   priceFeedABI,
 *   provider,
 *   'swap-123'
 * );
 */
async function calculateSwapAmounts(
  amount: string,
  tokenInDecimals: number,
  tokenOutDecimals: number,
  effectivePriceIn: number,
  effectivePriceOut: number,
  feeInCents: ethers.BigNumber,
  chatterPayContract: ethers.Contract,
  tokenOutSymbol: string,
  tokenOut: string,
  isOutStable: boolean,
  logKey: string
) {
  const feeInTokenIn = SWAP_ZERO_FEE_MODE
    ? ethers.constants.Zero
    : calculateFeeInToken(feeInCents, tokenInDecimals, effectivePriceIn, logKey);

  const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
  const swapAmount = amountInBN.sub(feeInTokenIn);

  const expectedOutput = SWAP_ZERO_FEE_MODE
    ? ethers.constants.Zero
    : calculateExpectedOutput(
        swapAmount,
        effectivePriceIn,
        effectivePriceOut,
        tokenInDecimals,
        tokenOutDecimals,
        logKey
      );

  const baseSlippage = await determineSlippage(
    chatterPayContract,
    tokenOutSymbol,
    isOutStable,
    tokenOut,
    logKey
  );
  const totalSlippage = baseSlippage + SLIPPAGE_CONFIG.EXTRA;
  const amountOutMin = expectedOutput.mul(10000 - totalSlippage).div(10000);

  return { amountInBN, amountOutMin };
}

/**
 * Calculates minimum output amount using price feeds as fallback method
 *
 * Fallback calculation method when Uniswap Quoter is unavailable. Uses Chainlink
 * and Binance price feeds to estimate output amount and applies slippage tolerance.
 * Provides a conservative estimate for swap operations.
 *
 * @param amount - Input amount as a string (e.g., "100.0")
 * @param tokenIn - Address of the input token
 * @param tokenOut - Address of the output token
 * @param tokenDetails - Object containing token metadata from fetchTokenDetails
 * @param chatterPayContract - Initialized ChatterPay contract instance
 * @param provider - Ethers provider instance for blockchain interaction
 * @param isOutStable - Boolean indicating if output token is a stablecoin
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Minimum output amount in BigNumber calculated from price feeds
 */
async function calculateAmountOutMinViaPriceFeeds(
  amount: string,
  tokenIn: string,
  tokenOut: string,
  tokenDetails: {
    tokenInDecimals: number;
    tokenOutDecimals: number;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    feeInCents: ethers.BigNumber;
  },
  chatterPayContract: ethers.Contract,
  provider: ethers.providers.Provider,
  isOutStable: boolean,
  effectivePriceIn: number,
  effectivePriceOut: number,
  logKey: string
): Promise<ethers.BigNumber> {
  const { amountOutMin } = await calculateSwapAmounts(
    amount,
    tokenDetails.tokenInDecimals,
    tokenDetails.tokenOutDecimals,
    effectivePriceIn,
    effectivePriceOut,
    tokenDetails.feeInCents,
    chatterPayContract,
    tokenDetails.tokenOutSymbol,
    tokenOut,
    isOutStable,
    logKey
  );

  return amountOutMin;
}

/**
 * Calculates and validates the minimum output amount by comparing Quoter and Price Feed methods
 *
 * Computes the minimum output amount using both Uniswap Quoter and Price Feed methods,
 * compares the results for consistency, and validates that the difference is within
 * acceptable limits (5%). Returns the best available price after validation.
 *
 * @param networkConfig - Blockchain network configuration
 * @param setupContractsResult - Setup results with provider and contract instances
 * @param tokenIn - Input token address
 * @param tokenOut - Output token address
 * @param amount - Input amount as string
 * @param amountInBN - Input amount in BigNumber (wei)
 * @param totalSlippage - Total slippage tolerance in basis points
 * @param tokenDetails - Token metadata including decimals and symbols
 * @param chatterPayContract - Initialized ChatterPay contract instance
 * @param isOutStable - Boolean indicating if output token is a stablecoin
 * @param recipient - Recipient address for the swap
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Validated minimum output amount in BigNumber
 * @throws Error if price difference exceeds 5% or if both calculation methods fail
 */
/**
 * Calculates and validates the minimum output amount using three different methods:
 * 1. Uniswap Quoter (on-chain)
 * 2. Price Feed calculation (off-chain price feeds)
 * 3. Direct price calculation (simple price ratio)
 *
 * Compares all three methods and returns the highest value, but validates that
 * differences between methods don't exceed 5% for price safety.
 */
async function calculateAndValidateAmountOutMin(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  tokenIn: string,
  tokenOut: string,
  amount: string,
  amountInBN: ethers.BigNumber,
  totalSlippage: number,
  tokenDetails: {
    tokenInDecimals: number;
    tokenOutDecimals: number;
    tokenInSymbol: string;
    tokenOutSymbol: string;
    feeInCents: ethers.BigNumber;
  },
  chatterPayContract: ethers.Contract,
  isOutStable: boolean,
  recipient: string,
  logKey: string
): Promise<ethers.BigNumber> {
  let quoterAmountOutMin: ethers.BigNumber | null = null;
  let priceFeedAmountOutMin: ethers.BigNumber | null = null;
  let directPriceAmountOutMin: ethers.BigNumber | null = null;

  // First get prices for reference
  let effectivePriceIn = 0;
  let effectivePriceOut = 0;

  try {
    ({ effectivePriceIn, effectivePriceOut } = await fetchTokenPrices(
      tokenIn,
      tokenOut,
      tokenDetails.tokenInSymbol,
      tokenDetails.tokenOutSymbol,
      chatterPayContract,
      (await getChainlinkPriceFeedABI())!,
      setupContractsResult.provider,
      logKey
    ));
  } catch (priceError) {
    Logger.warn(
      'calculateAndValidateAmountOutMin',
      logKey,
      `Failed to fetch token prices: ${priceError}`
    );
    effectivePriceIn = 0;
    effectivePriceOut = 0;
  }

  // 1) Calculate via Uniswap Quoter (on-chain)
  try {
    if (networkConfig.contracts.quoterAddress && SWAP_USE_QUOTER) {
      Logger.info('calculateAndValidateAmountOutMin', logKey, 'Calculating via Uniswap Quoter');
      const result = await getAmountOutMinViaQuoter({
        provider: setupContractsResult.provider,
        quoterAddress: networkConfig.contracts.quoterAddress!,
        params: {
          tokenIn,
          tokenOut,
          fee: 3000, // Default Uniswap fee
          recipient,
          amountIn: amountInBN,
          sqrtPriceLimitX96: ethers.constants.Zero
        },
        slippageBps: totalSlippage,
        logKey
      });
      quoterAmountOutMin = result.amountOutMin;
    }
  } catch (quoterError) {
    Logger.warn(
      'calculateAndValidateAmountOutMin',
      logKey,
      `Quoter calculation failed: ${quoterError}`
    );
  }

  // 2) Calculate via Price Feeds (off-chain)
  try {
    if (effectivePriceIn > 0 && effectivePriceOut > 0) {
      Logger.info('calculateAndValidateAmountOutMin', logKey, 'Calculating via Price Feeds');
      priceFeedAmountOutMin = await calculateAmountOutMinViaPriceFeeds(
        amount,
        tokenIn,
        tokenOut,
        tokenDetails,
        chatterPayContract,
        setupContractsResult.provider,
        isOutStable,
        effectivePriceIn,
        effectivePriceOut,
        logKey
      );
    }
  } catch (priceFeedError) {
    Logger.warn(
      'calculateAndValidateAmountOutMin',
      logKey,
      `Price feed calculation failed: ${priceFeedError}`
    );
  }

  // 3) Calculate direct reference amount (what we expect based on fixed price)
  try {
    if (effectivePriceOut > 0) {
      // Calculate input value in USD
      const amountInUSD =
        Number(ethers.utils.formatUnits(amountInBN, tokenDetails.tokenInDecimals)) *
        effectivePriceIn;

      // Calculate expected tokens based on fixed output price
      const expectedTokenAmount = amountInUSD / effectivePriceOut;

      directPriceAmountOutMin = ethers.utils.parseUnits(
        expectedTokenAmount.toFixed(tokenDetails.tokenOutDecimals),
        tokenDetails.tokenOutDecimals
      );

      Logger.info(
        'calculateAndValidateAmountOutMin',
        logKey,
        `Direct price reference: ${ethers.utils.formatUnits(directPriceAmountOutMin, tokenDetails.tokenOutDecimals)} ${tokenDetails.tokenOutSymbol} ` +
          `(based on ${effectivePriceOut} USD/${tokenDetails.tokenOutSymbol})`
      );
    }
  } catch (directPriceError) {
    Logger.warn(
      'calculateAndValidateAmountOutMin',
      logKey,
      `Direct price calculation failed: ${directPriceError}`
    );
  }

  // Collect all available amounts
  const availableAmounts: { method: string; amount: ethers.BigNumber }[] = [];

  if (quoterAmountOutMin && quoterAmountOutMin.gt(0)) {
    availableAmounts.push({ method: 'Quoter', amount: quoterAmountOutMin });
  }
  if (priceFeedAmountOutMin && priceFeedAmountOutMin.gt(0)) {
    availableAmounts.push({ method: 'Price Feed', amount: priceFeedAmountOutMin });
  }

  // If we have a direct price reference, use it for validation
  if (directPriceAmountOutMin && directPriceAmountOutMin.gt(0)) {
    availableAmounts.push({ method: 'Direct Price', amount: directPriceAmountOutMin });
  }

  // If no methods succeeded, throw error
  if (availableAmounts.length === 0) {
    throw new Error('All calculation methods produced invalid results');
  }

  // Convert all amounts to USD for comparison (if we have prices)
  if (effectivePriceOut > 0 && directPriceAmountOutMin) {
    const amountsWithUSD = availableAmounts.map((item) => ({
      method: item.method,
      amount: item.amount,
      usdValue:
        Number(ethers.utils.formatUnits(item.amount, tokenDetails.tokenOutDecimals)) *
        effectivePriceOut
    }));

    // Get the direct price USD value for comparison
    const directPriceUSD =
      Number(ethers.utils.formatUnits(directPriceAmountOutMin, tokenDetails.tokenOutDecimals)) *
      effectivePriceOut;

    // Log all values in USD
    amountsWithUSD.forEach((item) => {
      Logger.info(
        'calculateAndValidateAmountOutMin',
        logKey,
        `${item.method} amount: ${item.amount}` +
          `, ${item.method} value: ${item.usdValue.toFixed(6)} USD ` +
          `(Direct reference: ${directPriceUSD.toFixed(6)} USD)`
      );
    });

    // Find the best available amount (highest USD value)
    const bestAmount = amountsWithUSD.reduce((prev, current) =>
      prev.usdValue > current.usdValue ? prev : current
    );

    // Calculate difference from direct reference
    const differenceFromDirect = ((bestAmount.usdValue - directPriceUSD) / directPriceUSD) * 100;

    Logger.info(
      'calculateAndValidateAmountOutMin',
      logKey,
      `Best method: ${bestAmount.method}, amount: ${bestAmount.amount}, Value: ${bestAmount.usdValue.toFixed(6)} USD, ` +
        `Difference from direct: ${differenceFromDirect.toFixed(2)}%`
    );

    // ONLY throw error if the BEST result is significantly worse than direct price
    if (differenceFromDirect < -SWAP_PRICE_THRESHOLD_PERCENT) {
      const errorMessage =
        `Best available price is ${Math.abs(differenceFromDirect).toFixed(2)}% worse than expected. ` +
        `Expected: ${directPriceUSD.toFixed(6)} USD, Best available: ${bestAmount.usdValue.toFixed(6)} USD. ` +
        `Maximum allowed difference: ${SWAP_PRICE_THRESHOLD_PERCENT}%`;

      Logger.error('calculateAndValidateAmountOutMin', logKey, errorMessage);
      throw new Error(errorMessage);
    }

    // If the best result is better than or close to direct price, use it
    Logger.info(
      'calculateAndValidateAmountOutMin',
      logKey,
      `Using ${bestAmount.method} result: ${ethers.utils.formatUnits(bestAmount.amount, tokenDetails.tokenOutDecimals)} ${tokenDetails.tokenOutSymbol}`
    );

    return bestAmount.amount;
  }

  // If we don't have USD prices, just use the highest amount
  Logger.info(
    'calculateAndValidateAmountOutMin',
    logKey,
    `Available amounts: ${availableAmounts.map((a) => `${a.method}: ${a.amount.toString()}`).join(', ')}`
  );

  // Use the greatest of the available values
  const bestAmount = availableAmounts.reduce((prev, current) =>
    prev.amount.gt(current.amount) ? prev : current
  );

  Logger.info(
    'calculateAndValidateAmountOutMin',
    logKey,
    `Using ${bestAmount.method} result (numerical comparison): ${bestAmount.amount.toString()}`
  );

  return bestAmount.amount;
}

/**
 * Validate feasibility before execution
 *
 * Performs pre-flight checks including balance verification, allowance checking,
 * price quoting, and liquidity validation. This simulation helps prevent failed
 * transactions by identifying potential issues in advance without on-chain costs.
 *
 * @param networkConfig - Blockchain network configuration containing contract addresses
 * @param setupContractsResult - Setup results with provider, signer, and proxy information
 * @param _entryPointContract - EntryPoint contract (unused in simulation, kept for signature compatibility)
 * @param tokenAddresses - Input and output token addresses for the swap
 * @param blockchainTokens - List of supported tokens with metadata
 * @param amount - Input amount as a string (e.g., "100.0")
 * @param recipient - Recipient address for the swapped tokens
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Boolean indicating whether the simulation passed (true) or failed (false)
 *
 * @example
 * const simulationPassed = await simulateSwap(
 *   networkConfig,
 *   setupResult,
 *   entryPointContract,
 *   { tokenInputAddress: usdcAddress, tokenOutputAddress: wethAddress },
 *   supportedTokens,
 *   '100.0',
 *   userAddress,
 *   'swap-123'
 * );
 */
export async function validateSwap(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  tokenAddresses: swapTokensData,
  blockchainTokens: IToken[],
  amount: string,
  recipient: string,
  logKey: string
): Promise<ValidateSwapResult> {
  const errors: string[] = [];
  let chatterPayContract: ethers.Contract | undefined;

  try {
    Logger.info(
      'validateSwap',
      logKey,
      `Starting validation. Amount: ${amount}, Recipient: ${recipient}`
    );

    // 1) ABIs & contratos mínimos
    const { chatterpayABI, erc20ABI } = await fetchRequiredABIs();
    const { provider, userPrincipal: signer } = setupContractsResult; // provider/signer disponibles
    const resultBase: ValidateSwapResult = {
      result: false,
      abis: { chatterpayABI, erc20ABI },
      errors
    };

    const { chatterPayAddress } = networkConfig.contracts;
    if (!chatterPayAddress) {
      const msg = 'Missing chatterPayAddress in network config';
      Logger.debug('validateSwap', logKey, msg);
      errors.push(msg);
      return resultBase;
    }
    chatterPayContract = new ethers.Contract(chatterPayAddress, chatterpayABI, signer);

    const tokenIn = tokenAddresses.tokenInputAddress;
    const tokenOut = tokenAddresses.tokenOutputAddress;
    if (!tokenIn || !tokenOut) {
      const msg = 'Missing tokenIn/tokenOut addresses';
      Logger.debug('validateSwap', logKey, msg);
      errors.push(msg);
      return resultBase;
    }

    // 2) Token details + amountIn
    const tokenDetails = await fetchTokenDetails(
      tokenIn,
      tokenOut,
      erc20ABI,
      provider as ethers.providers.Provider,
      chatterPayContract,
      logKey
    );

    const amountInBN = ethers.utils.parseUnits(amount, tokenDetails.tokenInDecimals);

    Logger.debug(
      'validateSwap',
      logKey,
      `Parsed amountIn: ${amountInBN.toString()} (${tokenDetails.tokenInSymbol} decimals=${tokenDetails.tokenInDecimals})`
    );

    // 3) Pre-chequeos de wallet: balance & allowance contra la wallet/proxy (chatterPayAddress)
    const erc20In = new ethers.Contract(tokenIn, erc20ABI, provider);
    const walletAddress = setupContractsResult.proxy?.proxyAddress;
    if (!walletAddress) {
      const msg = 'Missing proxy wallet address in setupContractsResult';
      Logger.debug('validateSwap', logKey, msg);
      errors.push(msg);
      return {
        ...resultBase,
        tokenDetails,
        amountInBN,
        errors
      };
    }

    const [balanceIn, allowanceIn] = await Promise.all([
      erc20In.balanceOf(walletAddress),
      erc20In.allowance(walletAddress, chatterPayAddress)
    ]);
    Logger.debug('validateSwap', logKey, `Wallet balanceIn: ${balanceIn.toString()}`);
    Logger.debug('validateSwap', logKey, `Current allowance: ${allowanceIn.toString()}`);

    if (balanceIn.lt(amountInBN)) {
      const msg = 'Insufficient balance for validation';
      Logger.debug('validateSwap', logKey, msg);
      errors.push(msg);
      return {
        ...resultBase,
        tokenDetails,
        amountInBN,
        errors
      };
    }

    if (allowanceIn.lt(amountInBN)) {
      Logger.info(
        'validateSwap',
        logKey,
        'Allowance is lower than amountIn. A prior approve will be required.'
      );
    }

    // 4) Slippage policy (idéntica a executeSwap)
    const tokenInfoOut = getTokenInfo(networkConfig, blockchainTokens, tokenOut);
    const isOutStable = tokenInfoOut?.type === 'stable';
    const baseSlippage = await determineSlippage(
      chatterPayContract,
      tokenDetails.tokenOutSymbol,
      isOutStable,
      tokenOut,
      logKey
    );
    const totalSlippage =
      baseSlippage +
      (isOutStable ? SLIPPAGE_CONFIG.STABLE : SLIPPAGE_CONFIG.DEFAULT) +
      SLIPPAGE_CONFIG.EXTRA;

    Logger.debug('validateSwap', logKey, `Base slippage: ${baseSlippage} bps`);
    Logger.debug('validateSwap', logKey, `Total slippage (policy): ${totalSlippage} bps`);

    // 5) Quoter (ruta/liquidez)
    if (!networkConfig.contracts.quoterAddress) {
      const msg = 'Missing quoterAddress in network config';
      Logger.debug('validateSwap', logKey, msg);
      errors.push(msg);
      return {
        ...resultBase,
        tokenDetails,
        amountInBN,
        tokenInfoOut,
        baseSlippage,
        errors
      };
    }

    const amountOutMin = await calculateAndValidateAmountOutMin(
      networkConfig,
      setupContractsResult,
      tokenIn,
      tokenOut,
      amount,
      amountInBN,
      totalSlippage,
      tokenDetails,
      chatterPayContract,
      isOutStable,
      recipient,
      logKey
    );

    Logger.debug('validateSwap', logKey, `amountOutMin from Quoter: ${amountOutMin.toString()}`);

    if (amountOutMin.lte(0)) {
      const msg = 'Quoted amountOutMin is zero or negative';
      Logger.debug('validateSwap', logKey, msg);
      errors.push(msg);
      return {
        ...resultBase,
        tokenDetails,
        amountInBN,
        tokenInfoOut,
        baseSlippage,
        amountOutMin,
        errors
      };
    }

    // 6) OK
    Logger.info('validateSwap', logKey, 'Validation passed ✅');
    return {
      result: true,
      abis: { chatterpayABI, erc20ABI },
      tokenDetails,
      amountInBN,
      tokenInfoOut,
      baseSlippage,
      amountOutMin,
      errors
    };
  } catch (err) {
    const msg = `Validation error: ${err instanceof Error ? err.message : String(err)}`;
    Logger.debug('validateSwap', logKey, msg);
    return {
      result: false,
      abis: await (async () => {
        try {
          const { chatterpayABI, erc20ABI } = await fetchRequiredABIs();
          return { chatterpayABI, erc20ABI };
        } catch {
          // en caso extremo, devolvemos placeholders vacíos
          return {
            chatterpayABI: [] as unknown as ContractInterface,
            erc20ABI: [] as unknown as ContractInterface
          };
        }
      })(),
      errors: [msg]
    };
  }
}

/**
 * Executes a token swap using the standard UserOperation flow with EntryPoint and Paymaster
 *
 * Performs a complete swap operation using Account Abstraction (ERC-4337) with gas sponsorship.
 * Includes simulation, price calculation, token approval, and swap execution via UserOperations.
 * Supports both Uniswap Quoter and fallback price feed calculation methods.
 *
 * @param networkConfig - Blockchain network configuration containing contract addresses
 * @param setupContractsResult - Setup results with provider, signer, backend signer, and proxy info
 * @param entryPointContract - Initialized EntryPoint contract for UserOperation execution
 * @param tokenAddresses - Input and output token addresses for the swap
 * @param blockchainTokens - List of supported tokens with metadata
 * @param amount - Input amount as a string (e.g., "100.0")
 * @param recipient - Recipient address for the swapped tokens
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing success status and transaction hashes for approval and swap operations
 *
 * @example
 * const result = await executeSwapStandard(
 *   networkConfig,
 *   setupResult,
 *   entryPointContract,
 *   { tokenInputAddress: usdcAddress, tokenOutputAddress: wethAddress },
 *   supportedTokens,
 *   '100.0',
 *   userAddress,
 *   'swap-123'
 * );
 */
export async function executeSwapStandard(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  tokenAddresses: swapTokensData,
  blockchainTokens: IToken[],
  amount: string,
  recipient: string,
  logKey: string
): Promise<ExecuteSwapResult> {
  Logger.info(
    'executeSwap',
    logKey,
    `Starting swap execution. Amount: ${amount}, Recipient: ${recipient}`
  );

  try {
    const validationResult: ValidateSwapResult = await validateSwap(
      networkConfig,
      setupContractsResult,
      tokenAddresses,
      blockchainTokens,
      amount,
      recipient,
      logKey
    );

    if (!validationResult.result) {
      throw new Error('Swap simulation did not pass');
    }

    // 0) Basic guards
    const tokenIn = tokenAddresses.tokenInputAddress;
    const tokenOut = tokenAddresses.tokenOutputAddress;

    // 1) ABIs & contracts
    const { chatterpayABI, erc20ABI } = validationResult.abis;
    const chatterPayContract = new ethers.Contract(
      networkConfig.contracts.chatterPayAddress,
      chatterpayABI,
      setupContractsResult.provider
    );

    // 2) Store initial paymaster deposit value
    const paymasterDepositValuePrev = await getPaymasterEntryPointDepositValue(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!
    );

    // 3) Check and approve token if needed
    const approveTrxHash = await checkAndApproveToken(
      networkConfig,
      tokenIn,
      validationResult.amountInBN!,
      setupContractsResult,
      erc20ABI,
      chatterPayContract,
      entryPointContract,
      logKey
    );

    // 4) Execute the swap
    const swapCallData = createSwapCallData(
      chatterPayContract,
      tokenIn,
      tokenOut,
      validationResult.amountInBN!,
      validationResult.amountOutMin!,
      recipient,
      logKey
    );

    // 5) Execute Swap Operation
    const userOpGasConfig = networkConfig.gas.operations.swap;
    const swapTransactionResult = await executeUserOperationWithRetry(
      networkConfig,
      setupContractsResult.provider,
      setupContractsResult.userPrincipal,
      entryPointContract,
      swapCallData,
      setupContractsResult.proxy.proxyAddress,
      'swap',
      logKey,
      userOpGasConfig.perGasInitialMultiplier,
      userOpGasConfig.perGasIncrement,
      userOpGasConfig.callDataInitialMultiplier,
      userOpGasConfig.maxRetries,
      userOpGasConfig.timeoutMsBetweenRetries
    );

    if (!swapTransactionResult.success) {
      throw new Error(swapTransactionResult.error);
    }

    // 6) Log final paymaster deposit
    await logPaymasterEntryPointDeposit(
      entryPointContract,
      networkConfig.contracts.paymasterAddress!,
      paymasterDepositValuePrev
    );

    return {
      success: true,
      approveTransactionHash: approveTrxHash ?? '',
      swapTransactionHash: swapTransactionResult.transactionHash
    };
  } catch (error) {
    Logger.error(
      'executeSwap',
      logKey,
      `Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return { success: false, swapTransactionHash: '', approveTransactionHash: '' };
  }
}

/**
 * Executes a token swap using direct EOA transactions (simple non-UserOperation flow)
 *
 * Performs a swap operation using traditional EOA transactions without Account Abstraction.
 * This bypasses EntryPoint and Paymaster, using direct contract calls with the signer
 * paying for gas. Includes token approval, gas funding, and swap execution in separate transactions.
 *
 * @param networkConfig - Blockchain network configuration containing contract addresses
 * @param setupContractsResult - Setup results with provider, signer, and backend signer instances
 * @param _entryPointContract - EntryPoint contract (unused, kept for signature symmetry)
 * @param tokenAddresses - Input and output token addresses for the swap
 * @param blockchainTokens - List of supported tokens with metadata
 * @param amount - Input amount as a string (e.g., "100.0")
 * @param recipient - Proxy contract address that will execute the swap
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing success status and transaction hashes for approval and swap operations
 *
 * @example
 * const result = await executeSwapSimple(
 *   networkConfig,
 *   setupResult,
 *   entryPointContract,
 *   { tokenInputAddress: usdcAddress, tokenOutputAddress: wethAddress },
 *   supportedTokens,
 *   '100.0',
 *   proxyAddress,
 *   'swap-123'
 * );
 */
export async function executeSwapSimple(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  _entryPointContract: ethers.Contract, // kept for signature symmetry
  tokenAddresses: swapTokensData,
  blockchainTokens: IToken[],
  amount: string,
  recipient: string,
  logKey: string
): Promise<ExecuteSwapResult> {
  Logger.info(
    'executeSwapSimple',
    logKey,
    `Starting SIMPLE swap. Amount: ${amount}, Recipient/Proxy: ${recipient}`
  );

  let approveTransactionHash = '';
  try {
    const validationResult: ValidateSwapResult = await validateSwap(
      networkConfig,
      setupContractsResult,
      tokenAddresses,
      blockchainTokens,
      amount,
      recipient,
      logKey
    );

    if (!validationResult.result) {
      throw new Error('Swap simulation did not pass');
    }

    // 0) Basic guards
    const tokenIn = tokenAddresses.tokenInputAddress;
    const tokenOut = tokenAddresses.tokenOutputAddress;

    // 1) ABIs & contracts
    const { chatterpayABI } = validationResult.abis;
    const { userPrincipal: signer, backPrincipal: backendSigner } = setupContractsResult;
    const { provider } = setupContractsResult;
    const chatterPayContract = new ethers.Contract(recipient, chatterpayABI, signer);

    // 2) Handle token approval
    // Calculate amount with 5% buffer for approval
    const approvalAmount = validationResult
      .amountInBN!.mul(105) // Add 5% buffer (100 + 5 = 105)
      .div(100); // Divide by 100 to get the percentage
    approveTransactionHash = await handleTokenApproval(
      networkConfig,
      setupContractsResult,
      tokenIn,
      recipient,
      approvalAmount,
      chatterPayContract,
      logKey
    );

    // 3) Estimate gas for swap
    const gasLimit = await gasService.getDynamicGas(
      chatterPayContract,
      'executeSwap',
      [tokenIn, tokenOut, validationResult.amountInBN!, validationResult.amountOutMin!, recipient],
      20,
      ethers.BigNumber.from('500000')
    );

    const feeData = await provider.getFeeData();
    Logger.debug('executeSwapSimple', logKey, `feeData: ${JSON.stringify(feeData)}`);
    const signerAddress = await signer.getAddress();

    // 4) Ensure signer has gas for SWAP transaction
    await ensureRecipientHasGas({
      provider,
      backendSigner,
      signerAddress,
      gasLimit,
      gasPrice: feeData.gasPrice ?? undefined,
      maxFeePerGas: feeData.maxFeePerGas ?? undefined,
      bufferBps: 500,
      logKey
    });

    // 5) Encode call data for executeSwap
    const swapCallData = createSwapCallData(
      chatterPayContract,
      tokenIn,
      tokenOut,
      validationResult.amountInBN!,
      validationResult.amountOutMin!,
      recipient,
      logKey
    );

    Logger.debug(
      'executeSwapSimple',
      logKey,
      `amountOutMin: ${validationResult.amountOutMin!.toString()}`
    );
    Logger.debug('executeSwapSimple', logKey, `swapCallData: ${swapCallData}`);

    // 9) Send the swap transaction
    const gasPrice = await provider.getGasPrice();
    const tx = await signer.sendTransaction({
      to: recipient,
      data: swapCallData,
      gasLimit,
      gasPrice
    });

    Logger.info('executeSwapSimple', logKey, `Tx sent: ${tx.hash}`);

    return {
      success: true,
      approveTransactionHash,
      swapTransactionHash: tx.hash
    };
  } catch (error) {
    Logger.error(
      'executeSwapSimple',
      logKey,
      `Simple swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return { success: false, swapTransactionHash: '', approveTransactionHash: '' };
  }
}

/**
 * Main swap execution router that selects between simple and standard swap modes
 *
 * Determines the appropriate swap execution path based on the SWAP_EXECUTE_SIMPLE
 * environment variable. Routes to either the simple EOA transaction flow or the
 * standard UserOperation flow with Account Abstraction and gas sponsorship.
 *
 * @param networkConfig - Blockchain network configuration containing contract addresses
 * @param setupContractsResult - Setup results with provider, signer, backend signer, and proxy info
 * @param entryPointContract - Initialized EntryPoint contract for UserOperation execution
 * @param tokenAddresses - Input and output token addresses for the swap
 * @param blockchainTokens - List of supported tokens with metadata
 * @param amount - Input amount as a string (e.g., "100.0")
 * @param recipient - Recipient address for the swapped tokens
 * @param logKey - Unique identifier for operation tracing and logging
 *
 * @returns Object containing success status and transaction hashes from the selected swap method
 *
 * @example
 * const result = await executeSwap(
 *   networkConfig,
 *   setupResult,
 *   entryPointContract,
 *   { tokenInputAddress: usdcAddress, tokenOutputAddress: wethAddress },
 *   supportedTokens,
 *   '100.0',
 *   userAddress,
 *   'swap-123'
 * );
 */
export async function executeSwap(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  tokenAddresses: swapTokensData,
  blockchainTokens: IToken[],
  amount: string,
  recipient: string,
  logKey: string
): Promise<ExecuteSwapResult> {
  const isSimple = String(SWAP_EXECUTE_SIMPLE || '').toLowerCase() === 'true';
  Logger.info('executeSwap', logKey, `Routing swap. EXECUTE_SWAP_SIMPLE=${isSimple}`);
  if (isSimple) {
    return executeSwapSimple(
      networkConfig,
      setupContractsResult,
      entryPointContract,
      tokenAddresses,
      blockchainTokens,
      amount,
      recipient,
      logKey
    );
  }
  return executeSwapStandard(
    networkConfig,
    setupContractsResult,
    entryPointContract,
    tokenAddresses,
    blockchainTokens,
    amount,
    recipient,
    logKey
  );
}
