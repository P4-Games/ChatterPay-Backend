import { type ContractInterface, ethers } from 'ethers';
import { Logger } from '../../helpers/loggerHelper';
import type {
  AaveReserveValidationResult,
  AaveSupplyInfo,
  AaveTokenBalanceInfo,
  AaveTokenInfo,
  AaveWithdrawResult
} from '../../types/aaveType';
import type { SetupContractReturn } from '../../types/commonType';
import { getERC20ABI } from '../web3/abiService';

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

const AAVE_POOL_WITHDRAW_ABI: ContractInterface = [
  ...AAVE_POOL_EXTENDED_ABI,
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)'
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

// ====== Internal Withdrawal Functions ======
/**
 * Withdraws a specific amount of an asset from Aave
 */
async function withdrawAmountInternal(
  asset: string,
  amountHuman: string,
  signer: ethers.Signer,
  logKey: string
): Promise<AaveWithdrawResult> {
  try {
    Logger.info('withdrawAmountInternal', logKey, `Withdrawing ${amountHuman} from Aave`, {
      asset
    });

    // Get pool address and instantiate contract
    const poolAddress = getPoolAddress();
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_WITHDRAW_ABI, signer);

    // Validate asset is supported on Aave
    const { supported, aTokenAddress } = await validateReserveOnAave(asset, signer);
    if (!supported) {
      throw new Error(`Asset ${asset} is not supported on Aave v3`);
    }

    if (!aTokenAddress) {
      throw new Error(`Could not retrieve aToken address for asset ${asset}`);
    }

    // Get token data and parse amount
    const erc20Abi = await getERC20ABI();
    const token = new ethers.Contract(asset, erc20Abi, signer);
    const decimals = await token.decimals();
    const amount = ethers.utils.parseUnits(amountHuman, decimals);

    // Check for outstanding debt
    const walletAddress = await signer.getAddress();
    const userAccountData = await pool.getUserAccountData(walletAddress);
    const { totalDebtBase } = userAccountData;

    if (totalDebtBase.gt(0)) {
      Logger.warn('withdrawAmountInternal', logKey, 'User has outstanding debt on Aave', {
        totalDebt: totalDebtBase.toString()
      });
    }

    // Get current aToken balance
    const aToken = new ethers.Contract(aTokenAddress, erc20Abi, signer);
    const aTokenBalance = await aToken.balanceOf(walletAddress);

    if (aTokenBalance.lt(amount)) {
      throw new Error(
        `Insufficient balance in Aave: have ${ethers.utils.formatUnits(aTokenBalance, decimals)}, trying to withdraw ${amountHuman}`
      );
    }

    Logger.info('withdrawAmountInternal', logKey, 'Balance check passed', {
      aTokenBalance: ethers.utils.formatUnits(aTokenBalance, decimals),
      amountToWithdraw: amountHuman
    });

    // Estimate gas with fallback
    let gasLimit: ethers.BigNumber;
    try {
      gasLimit = await pool.estimateGas.withdraw(asset, amount, walletAddress);
      Logger.debug('withdrawAmountInternal', logKey, `Estimated gas: ${gasLimit.toString()}`);
    } catch (error) {
      Logger.info(
        'withdrawAmountInternal',
        logKey,
        'Gas estimation failed, using manual gas limit of 300000'
      );
      gasLimit = ethers.BigNumber.from(300000);
    }

    // Execute withdrawal
    Logger.info('withdrawAmountInternal', logKey, 'Executing withdrawal...');
    const tx = await pool.withdraw(asset, amount, walletAddress, { gasLimit });
    Logger.info('withdrawAmountInternal', logKey, `Withdrawal transaction: ${tx.hash}`);

    const receipt = await tx.wait();
    Logger.info(
      'withdrawAmountInternal',
      logKey,
      `Withdrawal confirmed in block: ${receipt.blockNumber}`
    );

    // Verify new balance
    const newATokenBalance = await aToken.balanceOf(walletAddress);
    Logger.info('withdrawAmountInternal', logKey, 'Balance after withdrawal', {
      newBalance: ethers.utils.formatUnits(newATokenBalance, decimals)
    });

    Logger.info('withdrawAmountInternal', logKey, 'Withdrawal successful');

    return {
      success: true,
      txHash: tx.hash,
      amountWithdrawn: amountHuman
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('withdrawAmountInternal', logKey, 'Error withdrawing from Aave', {
      asset,
      amount: amountHuman,
      error: errorMessage
    });

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Withdraws 100% of available balance of an asset from Aave
 */
async function withdrawMaxInternal(
  asset: string,
  signer: ethers.Signer,
  logKey: string
): Promise<AaveWithdrawResult> {
  try {
    Logger.info('withdrawMaxInternal', logKey, 'Withdrawing maximum available from Aave', {
      asset
    });

    // Get pool address and instantiate contract
    const poolAddress = getPoolAddress();
    const pool = new ethers.Contract(poolAddress, AAVE_POOL_WITHDRAW_ABI, signer);

    // Validate asset is supported on Aave
    const { supported, aTokenAddress } = await validateReserveOnAave(asset, signer);
    if (!supported) {
      throw new Error(`Asset ${asset} is not supported on Aave v3`);
    }

    if (!aTokenAddress) {
      throw new Error(`Could not retrieve aToken address for asset ${asset}`);
    }

    // Get aToken balance
    const erc20Abi = await getERC20ABI();
    const aToken = new ethers.Contract(aTokenAddress, erc20Abi, signer);
    const walletAddress = await signer.getAddress();
    const aTokenBalance = await aToken.balanceOf(walletAddress);

    // Get decimals for formatting
    const token = new ethers.Contract(asset, erc20Abi, signer);
    const decimals = await token.decimals();

    if (aTokenBalance.eq(0)) {
      throw new Error('No balance available to withdraw');
    }

    const amountHuman = ethers.utils.formatUnits(aTokenBalance, decimals);
    Logger.info('withdrawMaxInternal', logKey, 'Current aToken balance', {
      balance: amountHuman
    });

    // Check for outstanding debt
    const userAccountData = await pool.getUserAccountData(walletAddress);
    const { totalDebtBase } = userAccountData;

    let tx: ethers.ContractTransaction;
    let actualWithdrawnHuman: string;

    if (totalDebtBase.gt(0)) {
      Logger.warn(
        'withdrawMaxInternal',
        logKey,
        'User has outstanding debt, using max withdrawal method',
        {
          totalDebt: totalDebtBase.toString()
        }
      );

      // Use MAX_UINT256 for maximum withdrawal when there's debt
      const maxAmount = ethers.constants.MaxUint256;

      // Estimate gas with fallback
      let gasLimit: ethers.BigNumber;
      try {
        gasLimit = await pool.estimateGas.withdraw(asset, maxAmount, walletAddress);
        Logger.debug('withdrawMaxInternal', logKey, `Estimated gas: ${gasLimit.toString()}`);
      } catch (error) {
        Logger.info(
          'withdrawMaxInternal',
          logKey,
          'Gas estimation failed, using manual gas limit of 300000'
        );
        gasLimit = ethers.BigNumber.from(300000);
      }

      // Execute withdrawal with max amount
      Logger.info('withdrawMaxInternal', logKey, 'Executing max withdrawal with debt...');
      tx = await pool.withdraw(asset, maxAmount, walletAddress, { gasLimit });

      // Calculate actual amount withdrawn
      const newATokenBalance = await aToken.balanceOf(walletAddress);
      const actualWithdrawn = aTokenBalance.sub(newATokenBalance);
      actualWithdrawnHuman = ethers.utils.formatUnits(actualWithdrawn, decimals);

      Logger.info('withdrawMaxInternal', logKey, 'Actual amount withdrawn with debt', {
        amount: actualWithdrawnHuman,
        remainingBalance: ethers.utils.formatUnits(newATokenBalance, decimals)
      });
    } else {
      // Withdraw full balance when no debt
      // Estimate gas with fallback
      let gasLimit: ethers.BigNumber;
      try {
        gasLimit = await pool.estimateGas.withdraw(asset, aTokenBalance, walletAddress);
        Logger.debug('withdrawMaxInternal', logKey, `Estimated gas: ${gasLimit.toString()}`);
      } catch (error) {
        Logger.info(
          'withdrawMaxInternal',
          logKey,
          'Gas estimation failed, using manual gas limit of 300000'
        );
        gasLimit = ethers.BigNumber.from(300000);
      }

      // Execute full withdrawal
      Logger.info('withdrawMaxInternal', logKey, 'Executing full withdrawal...');
      tx = await pool.withdraw(asset, aTokenBalance, walletAddress, { gasLimit });
      actualWithdrawnHuman = amountHuman;

      // Verify balance is zero
      const newATokenBalance = await aToken.balanceOf(walletAddress);
      if (!newATokenBalance.eq(0)) {
        Logger.warn('withdrawMaxInternal', logKey, 'Residual balance after withdrawal', {
          residual: ethers.utils.formatUnits(newATokenBalance, decimals)
        });
      }
    }

    Logger.info('withdrawMaxInternal', logKey, `Withdrawal transaction: ${tx.hash}`);

    const receipt = await tx.wait();
    Logger.info(
      'withdrawMaxInternal',
      logKey,
      `Withdrawal confirmed in block: ${receipt.blockNumber}`
    );

    Logger.info('withdrawMaxInternal', logKey, 'Max withdrawal successful');

    return {
      success: true,
      txHash: tx.hash,
      amountWithdrawn: actualWithdrawnHuman
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    Logger.error('withdrawMaxInternal', logKey, 'Error withdrawing max from Aave', {
      asset,
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

      const signer = setupContractsResult.userPrincipal as ethers.Signer;

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

      const signer = setupContractsResult.userPrincipal as ethers.Signer;

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
  },

  /**
   * Withdraws a specific amount of an asset from Aave
   */
  withdrawAmount: async (
    setupContractsResult: SetupContractReturn,
    amount: string,
    logKey: string
  ): Promise<AaveWithdrawResult> => {
    try {
      Logger.info('withdrawAmount', logKey, `Attempting to withdraw ${amount} from Aave`, {
        USDC_ADDRESS
      });

      const signer = setupContractsResult.userPrincipal as ethers.Signer;

      const result = await withdrawAmountInternal(USDC_ADDRESS, amount, signer, logKey);

      if (result.success) {
        Logger.info(
          'withdrawAmount',
          logKey,
          `Withdrawal successful. Transaction: ${result.txHash}`
        );
      } else {
        Logger.error('withdrawAmount', logKey, `Withdrawal failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('withdrawAmount', logKey, 'Unexpected error in withdrawal', {
        USDC_ADDRESS,
        amount,
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  },

  /**
   * Withdraws 100% of available balance of an asset from Aave
   */
  withdrawMax: async (
    setupContractsResult: SetupContractReturn,
    logKey: string
  ): Promise<AaveWithdrawResult> => {
    const asset = USDC_ADDRESS;
    try {
      Logger.info('withdrawMax', logKey, 'Attempting to withdraw maximum from Aave', { asset });

      const signer = setupContractsResult.userPrincipal as ethers.Signer;

      const result = await withdrawMaxInternal(asset, signer, logKey);

      if (result.success) {
        Logger.info(
          'withdrawMax',
          logKey,
          `Max withdrawal successful. Transaction: ${result.txHash}`
        );
      } else {
        Logger.error('withdrawMax', logKey, `Max withdrawal failed: ${result.error}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      Logger.error('withdrawMax', logKey, 'Unexpected error in max withdrawal', {
        asset,
        error: errorMessage
      });

      return {
        success: false,
        error: errorMessage
      };
    }
  }
};
