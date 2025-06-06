/* eslint-disable no-console */
import dotenv from 'dotenv';
import { ethers } from 'ethers';

import { resolveRpcUrl } from './common';
import { Logger } from '../../src/helpers/loggerHelper';

// Load environment variables
dotenv.config();

/**
 * Direct swap execution script that bypasses the UserOp and EntryPoint system
 * This script will connect directly as the owner and execute the swap functions
 */
async function executeDirectSwap(
  provider: ethers.providers.JsonRpcProvider,
  chatterPayAddress: string,
  proxyAddress: string,
  tokenIn: string,
  tokenOut: string,
  amount: string,
  recipient: string
): Promise<boolean> {
  Logger.info('executeDirectSwap', '=====================================================');
  Logger.info('executeDirectSwap', 'DIRECT SWAP EXECUTION (BYPASSING USEROP/ENTRYPOINT)');
  Logger.info('executeDirectSwap', '=====================================================');

  try {
    // 1. Load contracts and ABIs
    Logger.info('executeDirectSwap', '1. Loading contracts...');

    const chatterPayABI = [
      'function approveToken(address token, uint256 amount) external',
      'function executeSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, address recipient) external',
      'function getSwapRouter() view returns (address)',
      'function owner() view returns (address)'
    ];

    const erc20ABI = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
      'function symbol() view returns (string)',
      'function allowance(address,address) view returns (uint256)'
    ];

    // Get signer
    if (!process.env.SIGNING_KEY) {
      throw new Error('Missing SIGNING_KEY in environment variables');
    }

    const signer = new ethers.Wallet(process.env.SIGNING_KEY, provider);
    Logger.info('executeDirectSwap', `Using signer address: ${signer.address}`);

    // Initialize contracts
    const proxy = new ethers.Contract(proxyAddress, chatterPayABI, provider);
    const proxyWithSigner = proxy.connect(signer);
    const tokenInContract = new ethers.Contract(tokenIn, erc20ABI, provider);
    const tokenOutContract = new ethers.Contract(tokenOut, erc20ABI, provider);

    Logger.info('executeDirectSwap', `ChatterPay Implementation: ${chatterPayAddress}`);
    Logger.info('executeDirectSwap', `Proxy: ${proxyAddress}`);
    Logger.info('executeDirectSwap', `TokenIn: ${tokenIn}`);
    Logger.info('executeDirectSwap', `TokenOut: ${tokenOut}`);

    // 2. Verify the owner
    /*
    Logger.info('executeDirectSwap', '\n2. Verifying owner permissions...');
    const proxyOwner = await proxy.owner();

    if (proxyOwner.toLowerCase() !== signer.address.toLowerCase()) {
      Logger.error(
        'executeDirectSwap',
        `ERROR: Signer (${signer.address}) is not the owner of the proxy (${proxyOwner})`
      );
      return false;
    }
    Logger.info('executeDirectSwap', 'Signer is the owner of the proxy ✅');
    */

    // 3. Get token information
    Logger.info('executeDirectSwap', '\n3. Getting token information...');

    const [tokenInSymbol, tokenInDecimals, tokenOutSymbol, tokenOutDecimals] = await Promise.all([
      tokenInContract.symbol(),
      tokenInContract.decimals(),
      tokenOutContract.symbol(),
      tokenOutContract.decimals()
    ]);

    Logger.info('executeDirectSwap', `TokenIn: ${tokenInSymbol} (${tokenInDecimals} decimals)`);
    Logger.info('executeDirectSwap', `TokenOut: ${tokenOutSymbol} (${tokenOutDecimals} decimals)`);

    // 4. Check initial balances
    Logger.info('executeDirectSwap', '\n4. Checking initial balances...');

    const amountInBN = ethers.utils.parseUnits(amount, tokenInDecimals);
    const initialInBalance = await tokenInContract.balanceOf(proxyAddress);
    const initialOutBalance = await tokenOutContract.balanceOf(recipient);

    Logger.info(
      'executeDirectSwap',
      `Initial ${tokenInSymbol} balance: ${ethers.utils.formatUnits(initialInBalance, tokenInDecimals)}`
    );
    Logger.info(
      'executeDirectSwap',
      `Initial ${tokenOutSymbol} balance: ${ethers.utils.formatUnits(initialOutBalance, tokenOutDecimals)}`
    );

    if (initialInBalance.lt(amountInBN)) {
      Logger.error(
        'executeDirectSwap',
        `ERROR: Insufficient balance. Need at least ${ethers.utils.formatUnits(amountInBN, tokenInDecimals)} ${tokenInSymbol}`
      );
      return false;
    }

    // 5. Check and approve tokens if needed
    Logger.info('executeDirectSwap', '\n5. Checking and approving tokens...');

    const router = await proxy.getSwapRouter();
    Logger.info('executeDirectSwap', `Router address: ${router}`);

    // Approve tokens if requested in environment
    if (process.env.ENABLE_TOKEN_APPROVAL === 'true') {
      Logger.info('executeDirectSwap', 'Token approval requested, executing approval...');

      try {
        const txOptions: { gasLimit?: number; gasPrice?: ethers.BigNumber } = {};
        if (process.env.GAS_LIMIT) txOptions.gasLimit = parseInt(process.env.GAS_LIMIT, 10);
        if (process.env.GAS_PRICE)
          txOptions.gasPrice = ethers.utils.parseUnits(process.env.GAS_PRICE, 'gwei');

        const approvalTx = await proxyWithSigner.approveToken(
          tokenIn,
          ethers.constants.MaxUint256,
          txOptions
        );

        Logger.info('executeDirectSwap', `Approval transaction sent: ${approvalTx.hash}`);
        Logger.info('executeDirectSwap', 'Waiting for confirmation...');
        await approvalTx.wait(1); // 1 block confirmation
        Logger.info('executeDirectSwap', 'Approval confirmed ✅');
      } catch (error) {
        Logger.error('executeDirectSwap', 'ERROR approving tokens:', error);
        return false;
      }
    } else {
      Logger.info(
        'executeDirectSwap',
        'Skipping token approval (ENABLE_TOKEN_APPROVAL not set to true)'
      );
    }

    // 6. Calculate amountOutMin with high slippage for testing
    Logger.info('executeDirectSwap', '\n6. Calculating amountOutMin with high slippage...');

    // Get slippage from environment or use default
    const slippagePercent = parseInt(process.env.SLIPPAGE_PERCENT || '99', 10);

    // Use a very low value to ensure swap works in testing
    // If ZERO_MINOUT is set to true, use 1 as the minimum out
    let amountOutMin;
    if (process.env.ZERO_MINOUT === 'true') {
      amountOutMin = ethers.BigNumber.from(1); // Practically 0
      Logger.info('executeDirectSwap', 'Using minimum output of 1 (ZERO_MINOUT=true)');
    } else {
      // Estimate minimal output with slippage
      const estimatedOut = amountInBN.mul(100 - slippagePercent).div(100);
      amountOutMin = estimatedOut;
      Logger.info('executeDirectSwap', `Using estimated output with ${slippagePercent}% slippage`);
    }

    Logger.info('executeDirectSwap', `AmountOutMin: ${amountOutMin.toString()}`);

    // 7. Execute the swap
    Logger.info('executeDirectSwap', '\n7. Executing swap...');

    // Get gas settings from environment or use defaults
    const gasLimit = process.env.GAS_LIMIT ? parseInt(process.env.GAS_LIMIT, 10) : undefined;
    const gasPrice = process.env.GAS_PRICE
      ? ethers.utils.parseUnits(process.env.GAS_PRICE, 'gwei')
      : undefined;

    const txOptions: { gasLimit?: number; gasPrice?: ethers.BigNumber } = {};
    if (gasLimit) txOptions.gasLimit = gasLimit;
    if (gasPrice) txOptions.gasPrice = gasPrice;

    if (Object.keys(txOptions).length > 0) {
      Logger.info('executeDirectSwap', 'Using custom gas settings:', txOptions);
    }

    try {
      const swapTx = await proxyWithSigner.executeSwap(
        tokenIn,
        tokenOut,
        amountInBN,
        amountOutMin,
        recipient,
        txOptions
      );

      Logger.info('executeDirectSwap', `Swap transaction sent: ${swapTx.hash}`);
      Logger.info('executeDirectSwap', 'Waiting for confirmation...');

      const receipt = await swapTx.wait();
      Logger.info(
        'executeDirectSwap',
        `Swap confirmed ✅ (block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()})`
      );

      // Check final token balances
      const finalInBalance = await tokenInContract.balanceOf(proxyAddress);
      const finalOutBalance = await tokenOutContract.balanceOf(recipient);

      Logger.info(
        'executeDirectSwap',
        `\nFinal ${tokenInSymbol} balance: ${ethers.utils.formatUnits(finalInBalance, tokenInDecimals)}`
      );
      Logger.info(
        'executeDirectSwap',
        `Final ${tokenOutSymbol} balance: ${ethers.utils.formatUnits(finalOutBalance, tokenOutDecimals)}`
      );

      const inDiff = initialInBalance.sub(finalInBalance);
      const outDiff = finalOutBalance.sub(initialOutBalance);

      Logger.info(
        'executeDirectSwap',
        `\n${tokenInSymbol} spent: ${ethers.utils.formatUnits(inDiff, tokenInDecimals)}`
      );
      Logger.info(
        'executeDirectSwap',
        `${tokenOutSymbol} received: ${ethers.utils.formatUnits(outDiff, tokenOutDecimals)}`
      );

      if (outDiff.gt(0)) {
        Logger.info('executeDirectSwap', '\nSWAP EXECUTED SUCCESSFULLY ✅');
        return true;
      }

      Logger.error('executeDirectSwap', '\nERROR: No tokens received ❌');
      return false;
    } catch (error) {
      Logger.error('executeDirectSwap', 'ERROR executing swap:', error);
      Logger.error('executeDirectSwap', 'Error details:', (error as Error).message);
      return false;
    }
  } catch (error) {
    Logger.error('executeDirectSwap', 'Execution error:', error);
    return false;
  }
}

// Main function
async function main() {
  try {
    // Get environment variables or use defaults
    const CHATTERPAY_ADDRESS =
      process.env.CHATTERPAY_ADDRESS || '0xBc5a2FE45C825BB091075664cae88914FB3f73f0';
    const PROXY_ADDRESS = process.env.PROXY_ADDRESS || '0x56b1f585c1a08dad9fcfe38ab2c8f8ee1620bdd4';
    const TOKEN_IN = process.env.TOKEN_IN || '0xE9C723D01393a437bac13CE8f925A5bc8E1c335c'; // WETH
    const TOKEN_OUT = process.env.TOKEN_OUT || '0xe6B817E31421929403040c3e42A6a5C5D2958b4A'; // USDT
    const AMOUNT = process.env.AMOUNT || '0.001'; // Small amount for testing
    const RECIPIENT = process.env.RECIPIENT || PROXY_ADDRESS; // Default to proxy address

    // RPC configuration
    const rpcUrl = resolveRpcUrl();

    // Configure provider
    Logger.info('main', `Connecting to ${rpcUrl}...`);
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

    // Execute direct swap
    Logger.info('main', 'Starting direct swap execution...');
    const result = await executeDirectSwap(
      provider,
      CHATTERPAY_ADDRESS,
      PROXY_ADDRESS,
      TOKEN_IN,
      TOKEN_OUT,
      AMOUNT,
      RECIPIENT
    );

    Logger.info('main', `\nExecution ${result ? 'successful ✅' : 'failed ❌'}`);

    process.exit(result ? 0 : 1);
  } catch (error) {
    Logger.error('main', 'Fatal error during execution:', error);
    process.exit(1);
  }
}

// Run the script
main();
