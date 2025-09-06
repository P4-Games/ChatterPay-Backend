import { ethers, ContractInterface } from 'ethers';

import { getERC20ABI } from '../web3/abiService';
import { Logger } from '../../helpers/loggerHelper';
import { SetupContractReturn } from '../../types/commonType';
import {
  AaveTokenInfo,
  AaveSupplyInfo,
  AaveTokenBalanceInfo,
  AaveReserveValidationResult
} from '../../types/aaveType';

// ====== HARD-CODED (Scroll Sepolia) ======
const USDC_ADDRESS = '0x2c9678042d52b97d27f2bd2947f7111d93f3dd0d';
const AUSDC_ADDRESS = '0x6E4A1BcBd3C3038e6957207cadC1A17092DC7ba3';
const POOL_ADDRESS = '0x48914C788295b5db23aF2b5F0B3BE775C4eA9440';

// Expected aTokens mapping for validation
const EXPECTED_ATOKENS: Record<string, string> = {
  [USDC_ADDRESS.toLowerCase()]: AUSDC_ADDRESS.toLowerCase()
};

// ABI for Aave V3 Pool
const AAVE_POOL_ABI: ContractInterface = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function getReserveData(address asset) view returns ((uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, address, uint8))'
];

// ====== Extended ABI for interest rate data ======
// ====== Extended ABI for complete reserve data ======
const AAVE_POOL_EXTENDED_ABI: ContractInterface = [
  ...AAVE_POOL_ABI,
  'function getReserveData(address asset) view returns ((uint256, uint128, uint128, uint128, uint128, uint128, uint40, uint16, address, address, address, address, address, uint8))',
  'function getReserveConfigurationData(address asset) view returns ((uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool))',
  'function getReservesList() view returns (address[])'
];
// ====== Result Types ======
type Ok = { success: true; txHash: string; aTokenAddress: string };
type Err = { success: false; error: string };
export type Result = Ok | Err;

// ====== Internal Utilities ======
function getPoolAddress(): string {
  return POOL_ADDRESS;
}

/**
 * Validates if an asset is supported on Aave and returns its aToken address
 */
async function validateReserveOnAave(
  asset: string,
  signer: ethers.Signer
): Promise<AaveReserveValidationResult> {
  try {
    const pool = new ethers.Contract(POOL_ADDRESS, AAVE_POOL_ABI, signer);
    const reserveData = await pool.getReserveData(asset);

    // Extract data from the reserveData tuple based on Aave's structure
    const configurationData = reserveData[0];
    const aTokenAddr = reserveData[8]; // aTokenAddress is at index 8

    const isConfigured = configurationData && configurationData > 0;
    const supported = Boolean(
      isConfigured && aTokenAddr && aTokenAddr !== ethers.constants.AddressZero
    );

    // Sanity check against expected aToken address
    const expected = EXPECTED_ATOKENS[asset.toLowerCase()];
    if (expected && aTokenAddr && aTokenAddr.toLowerCase() !== expected) {
      Logger.warn('validateReserveOnAave', 'aToken address mismatch', {
        asset,
        aTokenFromAave: aTokenAddr,
        expectedAToken: expected
      });
    }

    return { supported, aTokenAddress: aTokenAddr };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('validateReserveOnAave', 'Could not validate reserve on Aave', {
      asset,
      error: errorMessage
    });
    return { supported: false };
  }
}

/**
 * Ensures the Aave pool has sufficient allowance to spend the specified token
 */
async function ensureAllowance(
  tokenAddress: string,
  signer: ethers.Signer,
  spenderAddress: string,
  amount: ethers.BigNumber,
  logKey: string
): Promise<void> {
  try {
    const erc20Abi = await getERC20ABI();
    const token = new ethers.Contract(tokenAddress, erc20Abi, signer);

    const owner = await signer.getAddress();
    const allowance: ethers.BigNumber = await token.allowance(owner, spenderAddress);

    if (allowance.gte(amount)) {
      Logger.debug('ensureAllowance', logKey, 'Sufficient allowance already exists');
      return;
    }

    Logger.info('ensureAllowance', logKey, 'Insufficient allowance, approving...');
    const txApprove = await token.approve(spenderAddress, ethers.constants.MaxUint256);
    Logger.info('ensureAllowance', logKey, `Approve transaction: ${txApprove.hash}`);

    await txApprove.wait();
    Logger.info('ensureAllowance', logKey, 'Approve confirmed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('ensureAllowance', logKey, 'Error ensuring allowance', { error: errorMessage });
    throw new Error(`Failed to ensure allowance: ${errorMessage}`);
  }
}

/**
 * Supplies USDC to Aave v3
 */
async function supplyUSDC(
  signer: ethers.Signer,
  amountHuman: string,
  onBehalfOf: string,
  logKey: string
): Promise<Ok> {
  try {
    // 1) Validate USDC support on Aave
    const { supported, aTokenAddress } = await validateReserveOnAave(USDC_ADDRESS, signer);

    if (!supported) {
      throw new Error('USDC is not active/supported as a reserve on Aave v3 for this network.');
    }

    if (!aTokenAddress) {
      throw new Error('Could not retrieve aToken address for USDC');
    }

    // 2) Instantiate contracts
    const poolAddress = getPoolAddress();
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_ABI, signer);
    const erc20Abi = await getERC20ABI();
    const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, signer);

    // 3) Get decimals and parse amount
    const decimals: number = await usdc.decimals();
    const amount = ethers.utils.parseUnits(amountHuman, decimals);

    // 4) Check balance
    const owner = await signer.getAddress();
    const balance: ethers.BigNumber = await usdc.balanceOf(owner);

    Logger.info(
      'supplyUSDC',
      logKey,
      `Balance: ${ethers.utils.formatUnits(balance, decimals)} USDC`
    );

    if (balance.lt(amount)) {
      throw new Error(`Insufficient USDC balance to supply. Need ${amountHuman} USDC.`);
    }

    // 5) Ensure allowance
    await ensureAllowance(USDC_ADDRESS, signer, poolAddress, amount, logKey);

    // 6) Estimate gas with manual fallback
    let gasLimit: ethers.BigNumber;
    try {
      gasLimit = await pool.estimateGas.supply(USDC_ADDRESS, amount, onBehalfOf, 0);
      Logger.debug('supplyUSDC', logKey, `Estimated gas: ${gasLimit.toString()}`);
    } catch (error) {
      Logger.info('supplyUSDC', logKey, 'Gas estimation failed, using manual gas limit of 300000');
      gasLimit = ethers.BigNumber.from(300000);
    }

    // 7) Execute supply
    Logger.info('supplyUSDC', logKey, 'Attempting USDC supply to Aave...');
    const tx = await pool.supply(USDC_ADDRESS, amount, onBehalfOf, 0, { gasLimit });
    Logger.info('supplyUSDC', logKey, `Supply transaction: ${tx.hash}`);

    const receipt = await tx.wait();
    Logger.info('supplyUSDC', logKey, `Supply confirmed in block: ${receipt.blockNumber}`);

    return { success: true, txHash: tx.hash, aTokenAddress };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('supplyUSDC', logKey, 'Error supplying USDC to Aave', { error: errorMessage });
    throw error; // Re-throw for centralized error handling
  }
}
/**
 * Retrieves token balance and Aave supply information for a specific wallet and token
 */
async function getTokenInfo(
  walletAddress: string,
  tokenAddress: string,
  aTokenAddress: string,
  signer: ethers.Signer
): Promise<AaveTokenInfo> {
  try {
    Logger.info('getTokenInfo', 'Fetching token information', {
      walletAddress,
      tokenAddress,
      aTokenAddress
    });

    // 1. Get aToken balance information (what user has supplied to Aave)
    const erc20Abi = await getERC20ABI();
    const aToken = new ethers.Contract(aTokenAddress, erc20Abi, signer);

    const [aTokenBalance, aTokenDecimals, aTokenSymbol] = await Promise.all([
      aToken.balanceOf(walletAddress),
      aToken.decimals(),
      aToken.symbol().catch(() => 'aToken')
    ]);

    // 2. Get original token balance (wallet balance)
    const token = new ethers.Contract(tokenAddress, erc20Abi, signer);
    const [tokenBalance, tokenDecimals, tokenSymbol] = await Promise.all([
      token.balanceOf(walletAddress),
      token.decimals(),
      token.symbol().catch(() => 'Token')
    ]);

    const tokenBalanceInfo: AaveTokenBalanceInfo = {
      balance: ethers.utils.formatUnits(tokenBalance, tokenDecimals),
      rawBalance: tokenBalance,
      decimals: tokenDecimals,
      symbol: tokenSymbol
    };

    // 3. Get Aave supply APY
    const poolAddress = getPoolAddress();
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_EXTENDED_ABI, signer);

    let supplyAPY = '0.00';

    try {
      const reserveData = await pool.getReserveData(tokenAddress);
      const currentLiquidityRate: ethers.BigNumber = reserveData[2];

      // Calculate APY from liquidity rate (Aave uses RAY units - 10^27)
      const aprDecimal = Number(ethers.utils.formatUnits(currentLiquidityRate, 27)); // ej: 0.60
      const aprPercent = (aprDecimal * 100).toFixed(2); // "60.00"
      supplyAPY = aprPercent;

      Logger.debug('getTokenInfo', 'APY calculated', {
        liquidityRate: currentLiquidityRate.toString(),
        calculatedAPY: supplyAPY
      });
    } catch (error) {
      Logger.warn('getTokenInfo', 'Could not fetch APY data', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const supplyInfo: AaveSupplyInfo = {
      supplyAPY,
      aTokenBalance: ethers.utils.formatUnits(aTokenBalance, aTokenDecimals),
      aTokenSymbol
    };

    Logger.debug('getTokenInfo', 'Token information retrieved', {
      walletBalance: tokenBalanceInfo.balance,
      aTokenBalance: supplyInfo.aTokenBalance,
      apy: supplyInfo.supplyAPY
    });

    return {
      success: true,
      tokenBalance: tokenBalanceInfo,
      supplyInfo
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('getTokenInfo', 'Error fetching token information', {
      walletAddress,
      tokenAddress,
      error: errorMessage
    });

    return {
      success: false,
      error: errorMessage
    };
  }
}
// ====== Public Service ======
export const aaveService = {
  /**
   * Supplies USDC to Aave v3 with tracking
   */
  supplyERC20: async (
    setupContractsResult: SetupContractReturn,
    amount: string,
    recipient: string,
    logKey: string
  ): Promise<Result> => {
    try {
      Logger.info(
        'supplyERC20',
        logKey,
        `Attempting to supply ${amount} USDC to Aave v3 on behalf of ${recipient}`
      );

      const signer = setupContractsResult.signer as ethers.Signer;

      // Supply USDC
      const result = await supplyUSDC(signer, amount, recipient, logKey);
      Logger.info(
        'supplyERC20',
        logKey,
        `USDC supplied successfully. Transaction: ${result.txHash}`
      );

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('supplyERC20', logKey, 'Supply operation failed', { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  },

  /**
   * Gets token balance and interest rate information for a specific wallet and token
   */
  getSupplyInfo: async (
    setupContractsResult: SetupContractReturn,
    walletAddress: string,
    logKey: string
  ): Promise<AaveTokenInfo> => {
    try {
      Logger.info(
        'getTokenInfo',
        logKey,
        `Fetching info for token ${USDC_ADDRESS} for wallet ${walletAddress}`
      );

      const signer = setupContractsResult.signer as ethers.Signer;

      const result = await getTokenInfo(walletAddress, USDC_ADDRESS, AUSDC_ADDRESS, signer);

      if (result.success) {
        Logger.info(
          'getTokenInfo',
          logKey,
          `Successfully retrieved token information for ${result.tokenBalance?.symbol}`
        );
      } else {
        Logger.warn(
          'getTokenInfo',
          logKey,
          `Failed to retrieve token information: ${result.error}`
        );
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('getTokenInfo', logKey, 'Unexpected error in getTokenInfo', {
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }
};
