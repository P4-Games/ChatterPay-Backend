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

import {
  type DepositWalletCall,
  RelayClient,
  RelayerTransactionState
} from '@polymarket/builder-relayer-client';
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
  PUSD_ADDRESS
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
      PUSD_ADDRESS,
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
        to: PUSD_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          CTF_EXCHANGE_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (allowanceNegRisk.lt(ethers.constants.MaxUint256.div(2))) {
      transactions.push({
        to: PUSD_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          NEG_RISK_CTF_EXCHANGE_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (allowanceNegRiskAdapter.lt(ethers.constants.MaxUint256.div(2))) {
      transactions.push({
        to: PUSD_ADDRESS,
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
    const relayerId = response.transactionID;
    const result = await response.wait();

    if (!result) {
      throw new Error(`Relayer approval transaction failed on-chain (relayer_id: ${relayerId})`);
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Missing approvals confirmed (tx: ${result.transactionHash}, relayer_id: ${relayerId})`
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

// ============================================================================
// Deposit Wallet (signatureType 3 / POLY_1271)
// ============================================================================

/**
 * Derive the expected deposit wallet address for an EOA (async — calls relayer).
 */
export async function deriveDepositWalletAddress(privateKey: string): Promise<string> {
  const client = createRelayClient(privateKey);
  return client.deriveDepositWalletAddress();
}

/**
 * Deploy a deposit wallet for the user via the Relayer.
 * Waits for STATE_CONFIRMED before returning.
 */
export async function deployDepositWallet(
  privateKey: string,
  logKey: string
): Promise<{ address: string }> {
  const fnLog = `[${LOG_PREFIX}:deployDepositWallet]`;

  try {
    const client = createRelayClient(privateKey);

    Logger.log('info', fnLog, `${logKey} Deploying deposit wallet`);
    const response = await client.deployDepositWallet();

    // wait() resolves at STATE_MINED or STATE_CONFIRMED (whichever comes first).
    // The relayer registry only updates at STATE_CONFIRMED — poll explicitly for it
    // so executeDepositWalletBatch doesn't get "wallet not registered" errors.
    await response.wait();
    await client.pollUntilState(
      response.transactionID,
      [RelayerTransactionState.STATE_CONFIRMED],
      RelayerTransactionState.STATE_FAILED,
      120,
      2000
    );

    const address = await client.deriveDepositWalletAddress();
    Logger.log('info', fnLog, `${logKey} Deposit wallet confirmed: ${address}`);
    return { address };
  } catch (error) {
    const msg = String(error);
    if (msg.includes('already deployed') || msg.includes('DEPOSIT_WALLET_DEPLOYED')) {
      // Wallet already exists — derive address and wait for registry confirmation
      // by polling for STATE_CONFIRMED on its deployment tx (best-effort: just derive)
      const client = createRelayClient(privateKey);
      const address = await client.deriveDepositWalletAddress();
      Logger.log('info', fnLog, `${logKey} Deposit wallet already deployed: ${address}`);
      return { address };
    }
    Logger.log('error', fnLog, `${logKey} Failed: ${msg}`);
    throw new Error(`Failed to deploy deposit wallet: ${msg}`);
  }
}

/**
 * Set all 6 required token approvals for a deposit wallet via executeDepositWalletBatch.
 * Mirrors ensureTokenApprovals but executed from the deposit wallet, not the Safe.
 */
export async function setupDepositWalletApprovals(
  privateKey: string,
  depositWalletAddress: string,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:setupDepositWalletApprovals]`;

  try {
    const client = createRelayClient(privateKey);

    Logger.log(
      'info',
      fnLog,
      `${logKey} Checking existing approvals for deposit wallet ${depositWalletAddress}`
    );

    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const usdc = new ethers.Contract(
      PUSD_ADDRESS,
      ['function allowance(address,address) view returns (uint256)'],
      provider
    );
    const ctf = new ethers.Contract(
      CTF_ADDRESS,
      ['function isApprovedForAll(address,address) view returns (bool)'],
      provider
    );

    const [
      allowanceCtf,
      allowanceNegRisk,
      allowanceNegRiskAdapter,
      isApprovedCtf,
      isApprovedNegRisk,
      isApprovedNegRiskAdapter
    ] = await Promise.all([
      usdc.allowance(depositWalletAddress, CTF_EXCHANGE_ADDRESS) as Promise<ethers.BigNumber>,
      usdc.allowance(
        depositWalletAddress,
        NEG_RISK_CTF_EXCHANGE_ADDRESS
      ) as Promise<ethers.BigNumber>,
      usdc.allowance(depositWalletAddress, NEG_RISK_ADAPTER_ADDRESS) as Promise<ethers.BigNumber>,
      ctf.isApprovedForAll(depositWalletAddress, CTF_EXCHANGE_ADDRESS) as Promise<boolean>,
      ctf.isApprovedForAll(depositWalletAddress, NEG_RISK_CTF_EXCHANGE_ADDRESS) as Promise<boolean>,
      ctf.isApprovedForAll(depositWalletAddress, NEG_RISK_ADAPTER_ADDRESS) as Promise<boolean>
    ]);

    const erc20Iface = new ethers.utils.Interface(ERC20_APPROVE_ABI);
    const erc1155Iface = new ethers.utils.Interface(ERC1155_APPROVE_ALL_ABI);
    const calls: DepositWalletCall[] = [];

    if (allowanceCtf.lt(ethers.constants.MaxUint256.div(2))) {
      calls.push({
        target: PUSD_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          CTF_EXCHANGE_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (allowanceNegRisk.lt(ethers.constants.MaxUint256.div(2))) {
      calls.push({
        target: PUSD_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          NEG_RISK_CTF_EXCHANGE_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (allowanceNegRiskAdapter.lt(ethers.constants.MaxUint256.div(2))) {
      calls.push({
        target: PUSD_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [
          NEG_RISK_ADAPTER_ADDRESS,
          ethers.constants.MaxUint256
        ]),
        value: '0'
      });
    }
    if (!isApprovedCtf) {
      calls.push({
        target: CTF_ADDRESS,
        data: erc1155Iface.encodeFunctionData('setApprovalForAll', [CTF_EXCHANGE_ADDRESS, true]),
        value: '0'
      });
    }
    if (!isApprovedNegRisk) {
      calls.push({
        target: CTF_ADDRESS,
        data: erc1155Iface.encodeFunctionData('setApprovalForAll', [
          NEG_RISK_CTF_EXCHANGE_ADDRESS,
          true
        ]),
        value: '0'
      });
    }
    if (!isApprovedNegRiskAdapter) {
      calls.push({
        target: CTF_ADDRESS,
        data: erc1155Iface.encodeFunctionData('setApprovalForAll', [
          NEG_RISK_ADAPTER_ADDRESS,
          true
        ]),
        value: '0'
      });
    }

    if (calls.length === 0) {
      Logger.log('info', fnLog, `${logKey} All deposit wallet approvals already set. Skipping...`);
      return;
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Submitting ${calls.length} approval(s) via deposit wallet batch`
    );

    // Retry if wallet registry hasn't propagated yet (can lag behind STATE_CONFIRMED by a few seconds)
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 6000;
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const deadline = Math.floor(Date.now() / 1000 + 3600).toString();
        const response = await client.executeDepositWalletBatch(
          calls,
          depositWalletAddress,
          deadline
        );
        const result = await response.wait();

        if (!result) {
          throw new Error('Deposit wallet approval batch failed on-chain');
        }

        Logger.log('info', fnLog, `${logKey} Deposit wallet approvals confirmed`);
        return;
      } catch (batchError) {
        lastError = batchError;
        if (String(batchError).includes('not registered') && attempt < MAX_RETRIES) {
          Logger.log(
            'warn',
            fnLog,
            `${logKey} Wallet not yet registered (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms...`
          );
          await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
        } else {
          throw batchError;
        }
      }
    }

    throw lastError;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Failed to setup deposit wallet approvals: ${String(error)}`);
  }
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
// Safe → Deposit Wallet Sweep
// ============================================================================

/**
 * Transfer all pUSD from the user's Safe wallet to their deposit wallet via the Relayer.
 * Used to recover funds that were bridged to the Safe before the deposit wallet migration.
 *
 * @param privateKey - User's EOA private key
 * @param depositWalletAddress - The user's deposit wallet address (migration target)
 * @param logKey - Logging identifier
 * @returns Amount swept (human readable), or 0 if nothing to sweep
 */
export async function sweepSafeToDepositWallet(
  privateKey: string,
  depositWalletAddress: string,
  logKey: string
): Promise<number> {
  const fnLog = `[${LOG_PREFIX}:sweepSafeToDepositWallet]`;

  try {
    const wallet = new ethers.Wallet(privateKey);
    const contractConfig = getContractConfig(POLYMARKET_CHAIN_ID);
    const safeAddress = deriveSafe(wallet.address, contractConfig.SafeContracts.SafeFactory);

    const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
    const usdc = new ethers.Contract(
      PUSD_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    const balance: ethers.BigNumber = await usdc.balanceOf(safeAddress);
    const balanceHuman = Number(ethers.utils.formatUnits(balance, 6));

    Logger.log(
      'info',
      fnLog,
      `${logKey} Safe ${safeAddress} pUSD balance: $${balanceHuman.toFixed(2)}`
    );

    if (balance.isZero()) {
      Logger.log('info', fnLog, `${logKey} Nothing to sweep`);
      return 0;
    }

    const erc20Iface = new ethers.utils.Interface([
      'function transfer(address to, uint256 amount) returns (bool)'
    ]);

    const client = createRelayClient(privateKey);
    const response = await client.execute(
      [
        {
          to: PUSD_ADDRESS,
          data: erc20Iface.encodeFunctionData('transfer', [depositWalletAddress, balance]),
          value: '0'
        }
      ],
      'Sweep pUSD from Safe to deposit wallet'
    );
    const result = await response.wait();

    if (!result) {
      throw new Error('Sweep transaction failed on-chain');
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Swept $${balanceHuman.toFixed(2)} pUSD from Safe ${safeAddress} → deposit wallet ${depositWalletAddress} (tx: ${result.transactionHash})`
    );
    return balanceHuman;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Sweep failed: ${String(error)}`);
    throw new Error(`Failed to sweep Safe to deposit wallet: ${String(error)}`);
  }
}

// ============================================================================
// Deposit Wallet pUSD Transfer
// ============================================================================

/**
 * Transfer a stablecoin from a deposit wallet to another Polygon address via the relayer.
 *
 * Uses a plain ERC-20 transfer() call (no approval needed, allowed by relayer).
 * Intended as step 1 of withdrawal: move funds to Safe so the Safe can approve
 * LiFi and bridge to Scroll without hitting the deposit wallet's spender allowlist.
 *
 * @param privateKey - User's EOA private key
 * @param depositWalletAddress - Source deposit wallet
 * @param recipientAddress - Destination address (typically the user's Safe)
 * @param amount - Amount in smallest units (6 decimals)
 * @param logKey - Logging identifier
 * @param tokenAddress - ERC-20 to move (defaults to pUSD; pass USDC.e for legacy redemption proceeds)
 */
export async function transferPusdFromDepositWallet(
  privateKey: string,
  depositWalletAddress: string,
  recipientAddress: string,
  amount: string,
  logKey: string,
  tokenAddress: string = PUSD_ADDRESS
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:transferPusdFromDepositWallet]`;

  // Clamp to actual on-chain balance to prevent "batch would revert" when the
  // requested amount is 1 unit over the real balance due to float rounding.
  const provider = new ethers.providers.JsonRpcProvider(POLYMARKET_POLYGON_RPC_URL);
  const token = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  const actualBalance: ethers.BigNumber = await token.balanceOf(depositWalletAddress);
  const requestedBn = ethers.BigNumber.from(amount);
  const transferAmount = actualBalance.lt(requestedBn) ? actualBalance : requestedBn;

  if (transferAmount.isZero()) {
    Logger.log('warn', fnLog, `${logKey} Deposit wallet balance is zero — skipping transfer`);
    return;
  }

  if (actualBalance.lt(requestedBn)) {
    Logger.log(
      'warn',
      fnLog,
      `${logKey} Requested ${requestedBn} but balance is ${actualBalance} — clamping transfer amount`
    );
  }

  Logger.log(
    'info',
    fnLog,
    `${logKey} Transferring ${transferAmount} (token ${tokenAddress}) from deposit wallet ${depositWalletAddress} → ${recipientAddress}`
  );

  const client = createRelayClient(privateKey);
  const erc20Iface = new ethers.utils.Interface([
    'function transfer(address to, uint256 amount) returns (bool)'
  ]);

  const calls: DepositWalletCall[] = [
    {
      target: tokenAddress,
      data: erc20Iface.encodeFunctionData('transfer', [
        recipientAddress,
        transferAmount.toString()
      ]),
      value: '0'
    }
  ];

  const deadline = Math.floor(Date.now() / 1000 + 3600).toString();
  const response = await client.executeDepositWalletBatch(calls, depositWalletAddress, deadline);
  const result = await response.wait();

  if (!result) {
    throw new Error('pUSD transfer from deposit wallet failed on-chain');
  }

  Logger.log('info', fnLog, `${logKey} Transfer confirmed (tx: ${result.transactionHash})`);
}

// ============================================================================
// Deposit Wallet Gasless Withdrawal (deprecated — use Safe routing instead)
// ============================================================================

/**
 * @deprecated Relayer blocks LiFi spender approval from deposit wallets.
 * Use transferPusdFromDepositWallet + executeGaslessWithdrawal instead.
 *
 * @param privateKey - User's EOA private key
 * @param depositWalletAddress - The user's deposit wallet address
 * @param withdrawData - LiFi bridge transaction details
 * @param amount - Amount being bridged (for the approval)
 * @param logKey - Logging identifier
 */
export async function executeDepositWalletWithdrawal(
  privateKey: string,
  depositWalletAddress: string,
  withdrawData: { approvalAddress: string; to: string; data: string; value: string },
  amount: string,
  logKey: string
): Promise<void> {
  const fnLog = `[${LOG_PREFIX}:executeDepositWalletWithdrawal]`;

  try {
    Logger.log('info', fnLog, `${logKey} Initiating gasless withdrawal via deposit wallet batch`);
    const client = createRelayClient(privateKey);
    const erc20Iface = new ethers.utils.Interface([
      'function approve(address spender, uint256 amount) public returns (bool)'
    ]);

    const calls: DepositWalletCall[] = [];

    if (
      withdrawData.approvalAddress &&
      withdrawData.approvalAddress !== ethers.constants.AddressZero
    ) {
      Logger.log('info', fnLog, `${logKey} Adding approval call for LiFi router`);
      calls.push({
        target: PUSD_ADDRESS,
        data: erc20Iface.encodeFunctionData('approve', [withdrawData.approvalAddress, amount]),
        value: '0'
      });
    }

    Logger.log('info', fnLog, `${logKey} Adding LiFi bridge call`);
    calls.push({
      target: withdrawData.to,
      data: withdrawData.data,
      value: BigInt(withdrawData.value || '0').toString() // normalize hex/null → decimal string
    });

    const deadline = Math.floor(Date.now() / 1000 + 3600).toString();
    const response = await client.executeDepositWalletBatch(calls, depositWalletAddress, deadline);
    const result = await response.wait();

    if (!result) {
      throw new Error('Deposit wallet withdrawal batch failed on-chain');
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Deposit wallet withdrawal confirmed (tx: ${result.transactionHash})`
    );
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Failed: ${String(error)}`);
    throw new Error(`Deposit wallet withdrawal failed: ${String(error)}`);
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
  logKey: string,
  tokenAddress: string = PUSD_ADDRESS
): Promise<string> {
  const fnLog = `[${LOG_PREFIX}:executeGaslessWithdrawal]`;

  try {
    Logger.log('info', fnLog, `${logKey} Initiating gasless withdrawal via Polymarket Relayer`);
    const client = createRelayClient(privateKey);
    const erc20ABI = ['function approve(address spender, uint256 amount) public returns (bool)'];
    const usdcInterface = new ethers.utils.Interface(erc20ABI);

    const transactions = [];

    // 1. Approve the LiFi router to spend the bridged token (pUSD or USDC.e)
    if (
      withdrawData.approvalAddress &&
      withdrawData.approvalAddress !== ethers.constants.AddressZero
    ) {
      Logger.log(
        'info',
        fnLog,
        `${logKey} Adding approval tx for LiFi router (token ${tokenAddress})`
      );
      transactions.push({
        to: tokenAddress,
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
    const response = await client.execute(transactions, 'Withdraw to Scroll');
    const relayerId = response.transactionID;
    const result = await response.wait();

    if (!result) {
      throw new Error(
        `Relayer withdrawal transaction failed on-chain (relayer_id: ${relayerId}). ` +
          `Check Polygon explorer for the tx hash printed above.`
      );
    }

    Logger.log(
      'info',
      fnLog,
      `${logKey} Gasless withdrawal confirmed on-chain (tx: ${result.transactionHash}, relayer_id: ${relayerId})`
    );
    return result.transactionHash;
  } catch (error) {
    Logger.log('error', fnLog, `${logKey} Gasless withdrawal failed: ${String(error)}`);
    throw new Error(`Gasless withdrawal failed: ${String(error)}`);
  }
}

// ============================================================================
// CTF Position Redemption
// ============================================================================

const CTF_REDEEM_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)'
];

/**
 * NegRiskAdapter redemption: distinct 2-arg signature. The adapter pulls the
 * user's conditional tokens, redeems them on the CTF using its wrapped
 * collateral, then unwraps the payout to the caller as pUSD.
 * `amounts` is always length 2: [yesAmount, noAmount] in raw 6-decimal units.
 * @see https://github.com/Polymarket/neg-risk-ctf-adapter
 */
const NEG_RISK_REDEEM_ABI = ['function redeemPositions(bytes32 conditionId, uint256[] amounts)'];

/** One position to redeem. CTF markets use `indexSet`; neg-risk markets also need the raw `amount` held. */
export interface RedeemPosition {
  conditionId: string;
  /** CTF index set: 1 = YES, 2 = NO */
  indexSet: number;
  /** True if the market is a neg-risk (multi-outcome) market — redeems via the NegRiskAdapter */
  negRisk?: boolean;
  /** Raw (6-decimal) balance of the winning outcome token. Required when `negRisk` is true. */
  amount?: string;
}

/**
 * Redeem one or more winning CTF positions via the Polymarket Relayer.
 *
 * Positions are held by the user's **deposit wallet** (signatureType 3 /
 * POLY_1271), so redemption MUST execute from there — not the Safe. The
 * redeemer (`msg.sender`) is the deposit wallet, which holds the outcome tokens
 * and has approved the NegRiskAdapter. Each position maps to one redemption
 * call; all are batched into a single deposit-wallet multi-send. Binary CTF
 * markets call `CTF.redeemPositions`; neg-risk markets call
 * `NegRiskAdapter.redeemPositions` (different signature, requires token amounts).
 *
 * @param privateKey           - User's EOA private key
 * @param depositWalletAddress - User's deposit wallet (polygon_address) that holds the positions
 * @param positions            - Positions to redeem (see {@link RedeemPosition})
 * @param logKey               - Logging identifier
 * @returns On-chain transaction hash
 */
export async function executeRedeemPositions(
  privateKey: string,
  depositWalletAddress: string,
  positions: RedeemPosition[],
  logKey: string
): Promise<string> {
  const fnLog = `[${LOG_PREFIX}:executeRedeemPositions]`;

  if (positions.length === 0) throw new Error('No positions to redeem');

  const client = createRelayClient(privateKey);
  const ctfIface = new ethers.utils.Interface(CTF_REDEEM_ABI);
  const negRiskIface = new ethers.utils.Interface(NEG_RISK_REDEEM_ABI);

  const calls: DepositWalletCall[] = positions.map(({ conditionId, indexSet, negRisk, amount }) => {
    if (negRisk) {
      // NegRiskAdapter expects [yesAmount, noAmount]; put the held balance in the
      // winning slot (indexSet 1 = YES, 2 = NO) and 0 in the other.
      const held = amount ?? '0';
      const amounts = indexSet === 1 ? [held, '0'] : ['0', held];
      return {
        target: NEG_RISK_ADAPTER_ADDRESS,
        data: negRiskIface.encodeFunctionData('redeemPositions', [conditionId, amounts]),
        value: '0'
      };
    }
    return {
      target: CTF_ADDRESS,
      data: ctfIface.encodeFunctionData('redeemPositions', [
        PUSD_ADDRESS,
        ethers.constants.HashZero,
        conditionId,
        [indexSet]
      ]),
      value: '0'
    };
  });

  Logger.log(
    'info',
    fnLog,
    `${logKey} Redeeming ${positions.length} position(s) via deposit wallet ${depositWalletAddress}`
  );

  const deadline = Math.floor(Date.now() / 1000 + 3600).toString();
  const response = await client.executeDepositWalletBatch(calls, depositWalletAddress, deadline);
  const relayerId = response.transactionID;
  const result = await response.wait();

  if (!result) {
    throw new Error(`Redeem positions failed on-chain (relayer_id: ${relayerId})`);
  }

  Logger.log(
    'info',
    fnLog,
    `${logKey} Redemptions confirmed (tx: ${result.transactionHash}, relayer_id: ${relayerId})`
  );
  return result.transactionHash;
}
