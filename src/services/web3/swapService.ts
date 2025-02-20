import { ethers, ContractInterface } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { addPaymasterData } from './paymasterService';
import { IBlockchain } from '../../models/blockchainModel';
import { sendUserOperationToBundler } from './bundlerService';
import { waitForUserOperationReceipt } from './userOpExecutorService';
import { getERC20ABI, getPriceFeedABI, getChatterpayABI } from '../gcp/gcpService';
import { signUserOperation, createGenericUserOperation } from './userOperationService';
import { TokenAddresses, ExecuteSwapResult, SetupContractReturn } from '../../types/commonType';

/**
 * Constants for slippage configurations based on token types
 */
const SLIPPAGE_CONFIG = {
  STABLE: 300,  // 3% for stablecoins
  DEFAULT: 500, // 5% default
  EXTRA: 300   // 3% extra
} as const;

/**
 * Token type classification
 */
const TOKEN_LISTS = {
  STABLE: ['USDT', 'USDC', 'DAI'],
} as {
  STABLE: string[];
};

/**
 * Executes a user operation with the given callData through the EntryPoint contract
 * 
 * @param networkConfig - Network configuration containing contract addresses and network details
 * @param callData - Encoded function call data
 * @param signer - Wallet for signing the transaction
 * @param backendSigner - Backend wallet for signing paymaster data
 * @param entrypointContract - EntryPoint contract instance
 * @param bundlerUrl - URL of the bundler service
 * @param proxyAddress - Address of the user's proxy contract
 * @param provider - Ethereum provider instance
 * @returns Transaction hash of the executed operation
 * @throws Error if the transaction fails or receipt is not found
 */
async function executeOperation(
  networkConfig: IBlockchain,
  callData: string,
  signer: ethers.Wallet,
  backendSigner: ethers.Wallet,
  entrypointContract: ethers.Contract,
  bundlerUrl: string,
  proxyAddress: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<string> {
  Logger.info('executeOperation', `Starting operation execution for proxy: ${proxyAddress}`);
  Logger.debug('executeOperation', `Network config: ${JSON.stringify(networkConfig)}`);
  
  // Get the current nonce for the proxy account
  const nonce = await entrypointContract.getNonce(proxyAddress, 0);
  Logger.info('executeOperation', `Current nonce for proxy ${proxyAddress}: ${nonce.toString()}`);

  // Create and prepare the user operation
  Logger.debug('executeOperation', 'Creating generic user operation');
  let userOperation = await createGenericUserOperation(callData, proxyAddress, nonce);
  Logger.debug('executeOperation', `Initial user operation: ${JSON.stringify(userOperation)}`);
  
  // Add paymaster data using the backend signer
  Logger.debug('executeOperation', `Adding paymaster data with address: ${networkConfig.contracts.paymasterAddress}`);
  userOperation = await addPaymasterData(
    userOperation,
    networkConfig.contracts.paymasterAddress!,
    backendSigner
  );
  Logger.debug('executeOperation', `User operation with paymaster: ${JSON.stringify(userOperation)}`);

  // Sign the user operation with the user's signer
  Logger.debug('executeOperation', 'Signing user operation');
  userOperation = await signUserOperation(
    userOperation,
    networkConfig.contracts.entryPoint,
    signer
  );
  Logger.info('executeOperation', 'User operation signed successfully');

  // Send the operation to the bundler and wait for receipt
  Logger.info('executeOperation', `Sending operation to bundler: ${bundlerUrl}`);
  const bundlerResponse = await sendUserOperationToBundler(
    bundlerUrl,
    userOperation,
    entrypointContract.address
  );
  Logger.debug('executeOperation', `Bundler response: ${JSON.stringify(bundlerResponse)}`);

  Logger.info('executeOperation', 'Waiting for operation receipt');
  const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
  
  if (!receipt?.success) {
    Logger.error('executeOperation', `Operation failed. Receipt: ${JSON.stringify(receipt)}`);
    throw new Error(
      `Transaction failed or not found. Receipt: ${receipt.success}, Hash: ${receipt.userOpHash}`
    );
  }

  Logger.info('executeOperation', `Operation completed successfully. Hash: ${receipt.receipt.transactionHash}`);
  return receipt.receipt.transactionHash;
}

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
  Logger.debug('createSwapCallData', `Creating swap call data. TokenIn: ${tokenIn}, TokenOut: ${tokenOut}, AmountIn: ${amountIn.toString()}, AmountOutMin: ${amountOutMin.toString()}, Recipient: ${recipient}`);
  
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
  tokenOut: string
): Promise<number> {
  Logger.debug('determineSlippage', `Determining slippage for token ${tokenSymbol}`);
  
  const customSlippage = await chatterPayContract.getCustomSlippage(tokenOut);
  Logger.debug('determineSlippage', `Custom slippage: ${customSlippage.toString()}`);
  
  if (customSlippage.gt(0)) {
    Logger.info('determineSlippage', `Using custom slippage: ${customSlippage.toString()}`);
    return customSlippage.toNumber();
  }

  if (TOKEN_LISTS.STABLE.includes(tokenSymbol)) {
    Logger.info('determineSlippage', `Using stable token slippage (${SLIPPAGE_CONFIG.STABLE}) for ${tokenSymbol}`);
    return SLIPPAGE_CONFIG.STABLE;
  } 

  Logger.info('determineSlippage', `Using default slippage (${SLIPPAGE_CONFIG.DEFAULT}) for ${tokenSymbol}`);
  return SLIPPAGE_CONFIG.DEFAULT;
}

/**
 * Executes a token swap with price checks and slippage protection
 */
export async function executeSwap(
  networkConfig: IBlockchain,
  setupContractsResult: SetupContractReturn,
  entryPointContract: ethers.Contract,
  tokenAddresses: TokenAddresses,
  amount: string,
  recipient: string
): Promise<ExecuteSwapResult> {
  Logger.info('executeSwap', `Starting swap execution. Amount: ${amount}, Recipient: ${recipient}`);
  Logger.debug('executeSwap', `Token addresses: ${JSON.stringify(tokenAddresses)}`);
  
  try {
    Logger.debug('executeSwap', 'Fetching contract ABIs');
    const abisPromises = [
      getChatterpayABI(),
      getERC20ABI(),
      getPriceFeedABI(),
    ];

    const [chatterpayABI, erc20ABI, priceFeedABI] = await Promise.all(abisPromises);
    Logger.debug('executeSwap', 'ABIs fetched successfully');

    // Initialize ChatterPay contract
    const chatterPayContract = new ethers.Contract(
      networkConfig.contracts.chatterPayAddress,
      chatterpayABI,
      setupContractsResult.provider
    );
    Logger.info('executeSwap', `ChatterPay contract initialized at ${networkConfig.contracts.chatterPayAddress}`);

    const { tokenAddressInput: tokenIn, tokenAddressOutput: tokenOut } = tokenAddresses;

    // Fetch token details
    Logger.debug('executeSwap', 'Fetching token details');

    Logger.debug('executeSwap', `ABIs first lines ERC20: ${JSON.stringify(erc20ABI).slice(0, 100)}, PriceFeed: ${JSON.stringify(priceFeedABI).slice(0, 100)}`);
    const [
      tokenInDecimals,
      tokenOutDecimals,
      tokenInSymbol,
      tokenOutSymbol,
      feeInCents
    ] = await Promise.all([
      getTokenDecimals(tokenIn, erc20ABI, setupContractsResult.provider),
      getTokenDecimals(tokenOut, erc20ABI, setupContractsResult.provider),
      getTokenSymbol(tokenIn, erc20ABI, setupContractsResult.provider),
      getTokenSymbol(tokenOut, erc20ABI, setupContractsResult.provider),
      chatterPayContract.getFeeInCents()
    ]);

    Logger.info('executeSwap', `Token details - Input: ${tokenInSymbol} (${tokenInDecimals} decimals), Output: ${tokenOutSymbol} (${tokenOutDecimals} decimals)`);
    Logger.debug('executeSwap', `Fee in cents: ${feeInCents.toString()}`);

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

    Logger.info('executeSwap', `Prices - Input: Chainlink ${chainlinkPriceIn.toString()}, Binance ${binancePriceIn}`);
    Logger.info('executeSwap', `Prices - Output: Chainlink ${chainlinkPriceOut.toString()}, Binance ${binancePriceOut}`);

    // Use the lower price for output token for safety
    const effectivePriceOut = !binancePriceOut ? 
      chainlinkPriceOut.toNumber() 
      : Math.min(chainlinkPriceOut.toNumber(), binancePriceOut);

    // Use the higher price for input token for safety
    const effectivePriceIn = !binancePriceIn ?
      chainlinkPriceIn.toNumber()
      : Math.max(chainlinkPriceIn.toNumber(), binancePriceIn);

    Logger.info('executeSwap', `Using effective prices - In: ${effectivePriceIn}, Out: ${effectivePriceOut}`);

    // Calculate fee and amounts
    const feeInTokenIn = calculateFeeInToken(
      feeInCents,
      tokenInDecimals,
      effectivePriceIn
    );
    Logger.debug('executeSwap', `Fee in input token: ${feeInTokenIn.toString()}`);

    const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
    const swapAmount = amountInBN.sub(feeInTokenIn);
    Logger.info('executeSwap', `Swap amount after fee: ${swapAmount.toString()}`);

    // Calculate expected output with price adjustment
    const expectedOutput = calculateExpectedOutput(
      swapAmount,
      chainlinkPriceIn,
      effectivePriceOut,
      tokenOutDecimals
    );
    Logger.info('executeSwap', `Expected output amount: ${expectedOutput.toString()}`);

    // Determine and apply slippage
    const baseSlippage = await determineSlippage(
      chatterPayContract,
      tokenOutSymbol,
      tokenOut
    );
    const totalSlippage = baseSlippage + SLIPPAGE_CONFIG.EXTRA;
    Logger.info('executeSwap', `Total slippage: ${totalSlippage} bps`);
    
    const amountOutMin = expectedOutput.mul(10000 - totalSlippage).div(10000);
    Logger.info('executeSwap', `Minimum output amount: ${amountOutMin.toString()}`);

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
    const swapHash = await executeOperation(
      networkConfig,
      swapCallData,
      setupContractsResult.signer,
      setupContractsResult.backendSigner,
      entryPointContract,
      setupContractsResult.bundlerUrl,
      setupContractsResult.proxy.proxyAddress,
      setupContractsResult.provider
    );

    Logger.info('executeSwap', `Swap completed successfully. Hash: ${swapHash}`);
    return {
      success: true,
      approveTransactionHash: swapHash,
      swapTransactionHash: swapHash
    };

  } catch (error) {
    Logger.error('executeSwap', `Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    Logger.debug('executeSwap', `Error details: ${JSON.stringify(error)}`);
    return { success: false, swapTransactionHash: '', approveTransactionHash: '' };
  }
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
): Promise<ethers.BigNumber> {
  Logger.debug('getChainlinkPrice', `Fetching Chainlink price from feed: ${priceFeedAddress}`);
  const priceFeed = new ethers.Contract(priceFeedAddress, priceFeedABI, provider);
  const roundData = await priceFeed.latestRoundData();
  Logger.debug('getChainlinkPrice', `Latest round data: ${JSON.stringify(roundData)}`);
  Logger.info('getChainlinkPrice', `Current price: ${roundData.answer.toString()}`);
  return roundData.answer;
}

async function getBinancePrice(symbol: string): Promise<number | null> {
  Logger.debug('getBinancePrice', `Fetching Binance price for symbol: ${symbol}`);
  
  // Special handling for WETH
  if (symbol === 'WETH' || symbol === "WBTC") {
    symbol = symbol.replace("W", "");
  }
  
  try {
    const url = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}USD`;
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
  Logger.debug('calculateFeeInToken', `Calculating fee. Fee in cents: ${feeInCents.toString()}, Decimals: ${tokenDecimals}, Token price: ${tokenPrice}`);
  
  const fee = feeInCents
    .mul(ethers.BigNumber.from(10).pow(tokenDecimals))
    .mul(ethers.BigNumber.from(1e8))
    .div(ethers.BigNumber.from(Math.floor(tokenPrice * 100)));
    
  Logger.debug('calculateFeeInToken', `Calculated fee in token: ${fee.toString()}`);
  return fee;
}

function calculateExpectedOutput(
  swapAmount: ethers.BigNumber,
  priceIn: ethers.BigNumber,
  priceOut: number,
  decimalsOut: number
): ethers.BigNumber {
  Logger.debug('calculateExpectedOutput', `Calculating expected output. Swap amount: ${swapAmount.toString()}, Price in: ${priceIn.toString()}, Price out: ${priceOut}, Decimals out: ${decimalsOut}`);
  
  const expectedOutput = swapAmount
    .mul(priceIn)
    .div(ethers.BigNumber.from(Math.floor(priceOut)))
    .mul(ethers.BigNumber.from(10).pow(decimalsOut))
    .div(1e8);
    
  Logger.info('calculateExpectedOutput', `Expected output amount: ${expectedOutput.toString()}`);
  return expectedOutput;
}