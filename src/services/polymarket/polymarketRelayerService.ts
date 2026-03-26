/**
 * Polymarket Relayer Service
 *
 * Handles gasless on-chain operations via Polymarket's Relayer:
 * - Safe wallet deployment
 * - Token approvals (USDC.e for CTF Exchange and Neg Risk CTF Exchange)
 *
 * All gas fees are sponsored by the Relayer — no MATIC/POL required.
 *
 * @see https://docs.polymarket.com/trading/gasless
 * @see https://docs.polymarket.com/resources/contract-addresses
 */

import { RelayClient, RelayerTransactionState } from '@polymarket/builder-relayer-client';
import { deriveSafe } from '@polymarket/builder-relayer-client/dist/builder/derive';
import { getContractConfig } from '@polymarket/builder-relayer-client/dist/config';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { ethers } from 'ethers';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

import {
  POLYMARKET_BUILDER_API_KEY,
  POLYMARKET_BUILDER_PASSPHRASE,
  POLYMARKET_BUILDER_SECRET,
  POLYMARKET_CHAIN_ID,
  POLYMARKET_POLYGON_RPC_URL,
  POLYMARKET_RELAYER_URL
} from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';
import {
  CTF_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
  NEG_RISK_CTF_EXCHANGE_ADDRESS,
  USDC_E_ADDRESS
} from './polymarketConstants';

const LOG_PREFIX = 'polymarketRelayerService';

// ============================================================================
// ABI fragments for on-chain approvals
// ============================================================================

const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];

const ERC1155_APPROVE_ALL_ABI = ['function setApprovalForAll(address operator, bool approved)'];

// ============================================================================
// Relayer Client Factory
// ============================================================================

/**
 * Create a RelayClient for a given user's private key.
 *
 * The RelayClient uses the Builder Program's HMAC-signed headers
 * to authenticate with the Polymarket Relayer.
 *
 * @param privateKey - User's EOA private key
 * @returns Configured RelayClient
 */
export function createRelayClient(privateKey: string): RelayClient {
  const account = privateKeyToAccount(privateKey as `0x${string}`);

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYMARKET_POLYGON_RPC_URL)
  });

  // Polyfill the transport for Polymarket SDK's ViemSigner compatibility (viem v2 vs v1)
  const transport = walletClient.transport as any;
  if (!transport.config) {
    transport.config = {
      url: transport.url,
      timeout: transport.timeout
    };
  }
  if (!transport.value) {
    transport.value = {
      url: transport.url
    };
  }

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key: POLYMARKET_BUILDER_API_KEY,
      secret: POLYMARKET_BUILDER_SECRET,
      passphrase: POLYMARKET_BUILDER_PASSPHRASE
    }
  });

  return new RelayClient(
    POLYMARKET_RELAYER_URL,
    POLYMARKET_CHAIN_ID,
    walletClient as any,
    builderConfig
  );
}

// ============================================================================
// Safe Wallet Deployment
// ============================================================================

/**
 * Deploy a Safe wallet for the user via the Relayer.
 *
 * This is a one-time operation. If the Safe is already deployed,
 * this function returns early without error.
 *
 * @param privateKey - User's EOA private key
 * @param logKey - Logging identifier
 * @returns The Safe (proxy) address, or null if already deployed
 */
export async function deploySafeWallet(
  privateKey: string,
  logKey: string
): Promise<{ deployed: boolean; proxyAddress: string }> {
  const fnLog = `[${LOG_PREFIX}:deploySafeWallet]`;

  try {
    const client = createRelayClient(privateKey);
    const wallet = new ethers.Wallet(privateKey);
    const signerAddress = wallet.address;

    Logger.log('info', fnLog, `${logKey} Checking Safe deployment for ${signerAddress}`);

    // Derive the expected Safe address deterministically via CREATE2
    const contractConfig = getContractConfig(POLYMARKET_CHAIN_ID);
    const proxyAddress = deriveSafe(signerAddress, contractConfig.SafeContracts.SafeFactory);

    // Check if already deployed
    const isDeployed = await client.getDeployed(proxyAddress);
    if (isDeployed) {
      Logger.log('info', fnLog, `${logKey} Safe already deployed: ${proxyAddress}`);
      return { deployed: true, proxyAddress };
    }

    Logger.log('info', fnLog, `${logKey} Deploying new Safe: ${proxyAddress}`);

    // The RelayClient internally derives the expected Safe address.
    try {
      const response = await client.deploy();
      const result = await response.wait();

      if (result) {
        Logger.log('info', fnLog, `${logKey} Safe deployed: ${result.proxyAddress}`);
        return { deployed: true, proxyAddress: result.proxyAddress };
      }

      // If wait() returned null but it was sent
      return { deployed: true, proxyAddress };
    } catch (deployError: unknown) {
      const errorMsg = String(deployError);
      // "Safe already deployed" is expected for returning users (race condition)
      if (errorMsg.includes('already deployed') || errorMsg.includes('SAFE_DEPLOYED')) {
        Logger.log(
          'info',
          fnLog,
          `${logKey} Safe already deployed (handled error): ${proxyAddress}`
        );
        return { deployed: true, proxyAddress };
      }
      throw deployError;
    }
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to deploy Safe wallet: ${String(error)}`);
  }
}

// ============================================================================
// Token Approvals
// ============================================================================

/**
 * Ensure all necessary token approvals for Polymarket trading.
 *
 * Approves (all batched into a single gasless relayer transaction):
 * 1. USDC.e → CTF Exchange (collateral for regular markets)
 * 2. USDC.e → Neg Risk CTF Exchange (collateral for neg risk markets)
 * 3. USDC.e → Neg Risk Adapter (required for neg risk market participation)
 * 4. CTF (ERC-1155) setApprovalForAll → CTF Exchange (required for selling positions)
 * 5. CTF (ERC-1155) setApprovalForAll → Neg Risk CTF Exchange (required for selling neg risk positions)
 * 6. CTF (ERC-1155) setApprovalForAll → Neg Risk Adapter (required for selling neg risk positions)
 *
 * @param privateKey - User's EOA private key
 * @param logKey - Logging identifier
 */
export async function ensureTokenApprovals(privateKey: string, logKey: string): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:ensureTokenApprovals]`;

  try {
    const client = createRelayClient(privateKey);
    const wallet = new ethers.Wallet(privateKey);
    const signerAddress = wallet.address;

    // Derived Safe address is the one that needs the approvals
    const contractConfig = getContractConfig(POLYMARKET_CHAIN_ID);
    const safeAddress = deriveSafe(signerAddress, contractConfig.SafeContracts.SafeFactory);

    Logger.log('info', fnLog, `${logKey} Checking existing approvals for Safe ${safeAddress}`);

    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const usdc = new ethers.Contract(
      USDC_E_ADDRESS,
      ['function allowance(address,address) view returns (uint256)'],
      provider
    );
    const ctf = new ethers.Contract(
      CTF_ADDRESS,
      ['function isApprovedForAll(address,address) view returns (bool)'],
      provider
    );

    // Parallel check of all 6 required approvals/allowances
    const [
      allowanceCtf,
      allowanceNegRisk,
      allowanceNegRiskAdapter,
      isApprovedCtf,
      isApprovedNegRisk,
      isApprovedNegRiskAdapter
    ] = await Promise.all([
      usdc.allowance(safeAddress, CTF_EXCHANGE_ADDRESS) as Promise<ethers.BigNumber>,
      usdc.allowance(safeAddress, NEG_RISK_CTF_EXCHANGE_ADDRESS) as Promise<ethers.BigNumber>,
      usdc.allowance(safeAddress, NEG_RISK_ADAPTER_ADDRESS) as Promise<ethers.BigNumber>,
      ctf.isApprovedForAll(safeAddress, CTF_EXCHANGE_ADDRESS) as Promise<boolean>,
      ctf.isApprovedForAll(safeAddress, NEG_RISK_CTF_EXCHANGE_ADDRESS) as Promise<boolean>,
      ctf.isApprovedForAll(safeAddress, NEG_RISK_ADAPTER_ADDRESS) as Promise<boolean>
    ]);

    const erc20Iface = new ethers.utils.Interface(ERC20_APPROVE_ABI);
    const erc1155Iface = new ethers.utils.Interface(ERC1155_APPROVE_ALL_ABI);
    const transactions = [];

    // --- ERC-20 checks (USDC.e) ---
    if (allowanceCtf.lt(ethers.constants.MaxUint256.div(2))) {
      transactions.push({
        to: USDC_E_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          CTF_EXCHANGE_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (allowanceNegRisk.lt(ethers.constants.MaxUint256.div(2))) {
      transactions.push({
        to: USDC_E_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          NEG_RISK_CTF_EXCHANGE_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (allowanceNegRiskAdapter.lt(ethers.constants.MaxUint256.div(2))) {
      transactions.push({
        to: USDC_E_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          NEG_RISK_ADAPTER_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }

    // --- ERC-1155 checks (Conditional Tokens) ---
    if (!isApprovedCtf) {
      transactions.push({
        to: CTF_ADDRESS,
        data: erc1155Iface.encodeFunctionData('setApprovalForAll', [CTF_EXCHANGE_ADDRESS, true]),
        value: '0'
      });
    }
    if (!isApprovedNegRisk) {
      transactions.push({
        to: CTF_ADDRESS,
        data: erc1155Iface.encodeFunctionData('setApprovalForAll', [
          NEG_RISK_CTF_EXCHANGE_ADDRESS,
          true
        ]),
        value: '0'
      });
    }
    if (!isApprovedNegRiskAdapter) {
      transactions.push({
        to: CTF_ADDRESS,
        data: erc1155Iface.encodeFunctionData('setApprovalForAll', [
          NEG_RISK_ADAPTER_ADDRESS,
          true
        ]),
        value: '0'
      });
    }

    if (transactions.length === 0) {
      Logger.log('info', fnLog, `${logKey} All Polymarket approvals already set. Skipping...`);
      return;
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Submitting ${transactions.length} missing approval txs to Relayer`
    );

    const response = await client.execute(transactions, 'Set missing Polymarket approvals');
    const result = await response.wait();

    if (!result || result.state === RelayerTransactionState.STATE_FAILED) {
      throw new Error(
        `Relayer approval transaction failed (tx: ${result?.transactionHash || 'N/A'})`
      );
    }

    Logger.log('info', fnLog, `${logKey} Missing approvals confirmed (tx: ${result.transactionHash})`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to ensure token approvals: ${String(error)}`);
  }
}

// ============================================================================
// Combined Setup (Deploy + Approve)
// ============================================================================

/**
 * Full gasless onboarding: deploy Safe wallet + set all token approvals.
 *
 * This should be called once during account creation. It's idempotent —
 * if the Safe is already deployed or approvals are already set,
 * the operations complete without error.
 *
 * @param privateKey - User's EOA private key
 * @param logKey - Logging identifier
 */
/**
 * Derive the expected Gnosis Safe address for an EOA signer.
 * Uses the same CREATE2 derivation as the Polymarket Relayer SDK.
 *
 * @param eoaAddress - The EOA wallet address
 * @returns The deterministic Safe address on Polygon
 */
export function deriveSafeAddress(eoaAddress: string): string {
  const contractConfig = getContractConfig(POLYMARKET_CHAIN_ID);
  return deriveSafe(eoaAddress, contractConfig.SafeContracts.SafeFactory);
}

export async function setupGaslessTrading(privateKey: string, logKey: string): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:setupGaslessTrading]`;

  try {
    Logger.log('info', fnLog, `${logKey} Starting gasless trading setup`);

    // Step 1: Deploy Safe wallet
    await deploySafeWallet(privateKey, logKey);

    // Step 2: Approve tokens for trading
    await ensureTokenApprovals(privateKey, logKey);

    Logger.log('info', fnLog, `${logKey} Gasless trading setup complete`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Setup failed: ${String(error)}`);
    throw new Error(`Gasless trading setup failed: ${String(error)}`);
  }
}

// ============================================================================
// Gasless Withdrawal
// ============================================================================

/**
 * Executes a gasless withdrawal from Polygon to Scroll using the Polymarket Relayer.
 *
 * @param privateKey - User's EOA private key
 * @param withdrawData - Object containing LiFi bridge transaction details
 * @param amount - Amount being bridged (for the approval)
 * @param logKey - Logging identifier
 */
export async function executeGaslessWithdrawal(
  privateKey: string,
  withdrawData: { approvalAddress: string; to: string; data: string; value: string },
  amount: string,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:executeGaslessWithdrawal]`;

  try {
    Logger.log('info', fnLog, `${logKey} Initiating gasless withdrawal via Polymarket Relayer`);
    const client = createRelayClient(privateKey);
    const erc20ABI = ['function approve(address spender, uint256 amount) public returns (bool)'];
    const usdcInterface = new ethers.utils.Interface(erc20ABI);

    const transactions = [];

    // 1. Approve LiFi router to spend USDC.e
    if (
      withdrawData.approvalAddress &&
      withdrawData.approvalAddress !== ethers.constants.AddressZero
    ) {
      Logger.log('info', fnLog, `${logKey} Adding approval tx for LiFi router`);
      transactions.push({
        to: USDC_E_ADDRESS,
        data: usdcInterface.encodeFunctionData('approve', [withdrawData.approvalAddress, amount]),
        value: '0'
      });
    }

    // 2. The actual LiFi bridge tx
    Logger.log('info', fnLog, `${logKey} Adding LiFi bridge tx`);
    transactions.push({
      to: withdrawData.to,
      data: withdrawData.data,
      value: withdrawData.value
    });

    Logger.log('info', fnLog, `${logKey} Executing transactions via Relayer`);
    await client.execute(transactions, 'Withdraw to Scroll');
    Logger.log('info', fnLog, `${logKey} Gasless withdrawal execution completed`);
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Gasless withdrawal failed: ${String(error)}`);
    throw new Error(`Gasless withdrawal failed: ${String(error)}`);
  }
}
