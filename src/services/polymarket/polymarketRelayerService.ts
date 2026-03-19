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

const LOG_PREFIX = 'polymarketRelayerService';

// ============================================================================
// Polymarket Contract Addresses (Polygon Mainnet)
// @see https://docs.polymarket.com/resources/contract-addresses
// ============================================================================

/** USDC.e (Bridged USDC) on Polygon — used as collateral */
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

/** CTF Exchange — the main order matching/settlement contract */
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

/** Neg Risk CTF Exchange — for negative risk (multi-outcome) markets */
const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

/** Conditional Token Framework — ERC1155 conditional tokens */
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

/** Neg Risk Adapter */
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

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
    Logger.log('info', fnLog, `${logKey} Setting up token approvals via Relayer`);

    const client = createRelayClient(privateKey);
    const erc20Iface = new ethers.utils.Interface(ERC20_APPROVE_ABI);
    const erc1155Iface = new ethers.utils.Interface(ERC1155_APPROVE_ALL_ABI);

    // --- ERC-20 approvals (USDC.e) ---

    // 1. USDC.e → CTF Exchange
    const approveCtfData = erc20Iface.encodeFunctionData('approve', [
      CTF_EXCHANGE_ADDRESS,
      ethers.constants.MaxUint256
    ]);

    // 2. USDC.e → Neg Risk CTF Exchange
    const approveNegRiskData = erc20Iface.encodeFunctionData('approve', [
      NEG_RISK_CTF_EXCHANGE_ADDRESS,
      ethers.constants.MaxUint256
    ]);

    // 3. USDC.e → Neg Risk Adapter
    const approveNegRiskAdapterData = erc20Iface.encodeFunctionData('approve', [
      NEG_RISK_ADAPTER_ADDRESS,
      ethers.constants.MaxUint256
    ]);

    // --- ERC-1155 approvals (Conditional Tokens) ---

    // 4. CTF setApprovalForAll → CTF Exchange (needed to sell outcome tokens)
    const ctfApproveExchangeData = erc1155Iface.encodeFunctionData('setApprovalForAll', [
      CTF_EXCHANGE_ADDRESS,
      true
    ]);

    // 5. CTF setApprovalForAll → Neg Risk CTF Exchange (needed to sell neg risk tokens)
    const ctfApproveNegRiskData = erc1155Iface.encodeFunctionData('setApprovalForAll', [
      NEG_RISK_CTF_EXCHANGE_ADDRESS,
      true
    ]);

    // 6. CTF setApprovalForAll → Neg Risk Adapter (needed to sell neg risk positions)
    const ctfApproveNegRiskAdapterData = erc1155Iface.encodeFunctionData('setApprovalForAll', [
      NEG_RISK_ADAPTER_ADDRESS,
      true
    ]);

    const transactions = [
      { to: USDC_E_ADDRESS, data: approveCtfData, value: '0' },
      { to: USDC_E_ADDRESS, data: approveNegRiskData, value: '0' },
      { to: USDC_E_ADDRESS, data: approveNegRiskAdapterData, value: '0' },
      { to: CTF_ADDRESS, data: ctfApproveExchangeData, value: '0' },
      { to: CTF_ADDRESS, data: ctfApproveNegRiskData, value: '0' },
      { to: CTF_ADDRESS, data: ctfApproveNegRiskAdapterData, value: '0' }
    ];

    Logger.log(
      'info',
      fnLog,
      `${logKey} Submitting ${transactions.length} approval txs to Relayer`
    );

    const response = await client.execute(
      transactions,
      'Approve USDC.e + CTF for Polymarket trading'
    );
    const result = await response.wait();

    if (!result) {
      throw new Error('Relayer returned no result for approval transaction');
    }

    if (result.state === RelayerTransactionState.STATE_FAILED) {
      throw new Error(`Relayer approval transaction failed: ${result.transactionHash}`);
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Token approvals confirmed (tx: ${result.transactionHash}, state: ${result.state})`
    );
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
