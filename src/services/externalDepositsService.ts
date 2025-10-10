import { getAddress } from 'ethers/lib/utils';
import { gql, request } from 'graphql-request';

import { UserModel } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenInfo } from './blockchainService';
import Token, { IToken } from '../models/tokenModel';
import { TransactionData } from '../types/commonType';
import { formatTokenAmount } from '../helpers/formatHelper';
import { mongoTokenService } from './mongo/mongoTokenService';
import Blockchain, { IBlockchain } from '../models/blockchainModel';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { sendReceivedExternalTransferNotification } from './notificationService';
import { mongoExternalDepositsService } from './mongo/mongoExternalDepositsService';
import {
  THE_GRAPH_API_KEY,
  EXTERNAL_DEPOSITS_PROVIDER,
  THE_GRAPH_EXTERNAL_DEPOSITS_URL,
  EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY
} from '../config/constants';

/**
 * GraphQL query to fetch external deposits.
 */
const THE_GRAPH_QUERY_EXTERNAL_DEPOSITS = gql`
  query getExternalDeposits($lastTimestamp: BigInt!) {
    chatterPayTransfers(
      where: { blockTimestamp_gt: $lastTimestamp }
      orderBy: blockTimestamp
      orderDirection: asc
      first: 1000
    ) {
      id
      from
      to
      value
      token
      blockNumber
      blockTimestamp
      transactionHash
    }
  }
`;

/**
 * Interface representing a transfer transaction from the subgraph.
 */
interface Transfer {
  id: string;
  from: string;
  to: string;
  value: string;
  token: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
}

/**
 * Processes pending external deposits from the Alchemy provider and records them in the `transactions` collection.
 *
 * This function mirrors the logic used in `processTheGraphExternalDeposit`, but sources deposits
 * from the local `external_deposits` schema populated by Alchemy webhooks.
 *
 * Business rules:
 * - Validates that the referenced token is listed and active for the given chain.
 * - Matches each deposit to a registered user by `wallets.wallet_proxy` (case-insensitive).
 * - Skips already processed or duplicated transactions (`trx_hash` exists).
 * - Converts raw on-chain values (BigInt strings) to numeric amounts using token decimals.
 * - Inserts valid deposits as `type: "external"` and `status: "completed"` in the `transactions` collection.
 * - Marks each processed record in `external_deposits` as `status: "processed"`.
 * - Optionally sends user notifications for new deposits when `sendNotification` is true.
 *
 * @async
 * @param {number} chainId - The blockchain network ID being processed.
 * @param {boolean} sendNotification - Whether to send deposit notifications to matched users.
 * @returns {Promise<string>} A summary message indicating how many deposits were inserted or skipped.
 */
const processAlchemyExternalDeposits = async (
  chainId: number,
  sendNotification: boolean
): Promise<string> => {
  const deposits = await mongoExternalDepositsService.getUnprocessedAlchemyDeposits(chainId);
  if (deposits.length === 0) {
    return 'No external deposits pending for processing (alchemy).';
  }

  type Totals = { inserted: number; skipped: number };

  const totals = await deposits.reduce<Promise<Totals>>(
    async (prevPromise, dep) => {
      const acc = await prevPromise;

      try {
        // Normalize token to satisfy type safety
        const tokenAddress = dep.token ?? '';
        const tokenObject = tokenAddress
          ? await mongoTokenService.getToken(tokenAddress, chainId)
          : null;

        if (!tokenObject) {
          Logger.warn(
            'processAlchemyExternalDeposit',
            `External deposit rejected: Token ${dep.token} is not listed for chain ${chainId}`
          );
          await mongoExternalDepositsService.markAsProcessedById(String(dep._id));
          return { inserted: acc.inserted, skipped: acc.skipped + 1 };
        }

        const normalizedTo = dep.to.toLowerCase();

        // Find users with at least one wallet_proxy that matches (case-insensitive)
        const candidates = await UserModel.find({
          'wallets.wallet_proxy': { $regex: new RegExp(`^${normalizedTo}$`, 'i') }
        });

        const user = candidates.find((u) =>
          u.wallets.some((w) => w.wallet_proxy && w.wallet_proxy.toLowerCase() === normalizedTo)
        );

        if (!user) {
          Logger.warn(
            'processAlchemyExternalDeposit',
            `No user found with wallet: ${dep.to}. Deposit not processed: ${dep.txHash}`
          );
          await mongoExternalDepositsService.markAsProcessedById(String(dep._id));
          return { inserted: acc.inserted, skipped: acc.skipped + 1 };
        }

        const value = formatTokenAmount(dep.value, dep.decimals);

        const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
        const blockchainTokens = await Token.find({ chain_id: chainId });
        const tokenInfo: IToken | undefined = getTokenInfo(
          networkConfig,
          blockchainTokens,
          tokenAddress
        );

        if (!tokenInfo) {
          Logger.warn(
            'processAlchemyExternalDeposit',
            `Token info not found for address: ${tokenAddress}`
          );
          await mongoExternalDepositsService.markAsProcessedById(String(dep._id));
          return { inserted: acc.inserted, skipped: acc.skipped + 1 };
        }

        // Skip if transaction already exists
        const already = await mongoTransactionService.existsByHash(dep.txHash);
        if (already) {
          await mongoExternalDepositsService.markAsProcessedById(String(dep._id));
          return { inserted: acc.inserted, skipped: acc.skipped + 1 };
        }

        const transactionData: TransactionData = {
          tx: dep.txHash,
          walletFrom: getAddress(dep.from),
          walletTo: getAddress(dep.to),
          amount: value,
          fee: 0,
          token: tokenInfo.symbol,
          type: 'deposit',
          status: 'completed',
          chain_id: chainId,
          date: new Date(),
          user_notes: ''
        };

        await mongoTransactionService.saveTransaction(transactionData);
        await mongoExternalDepositsService.markAsProcessedById(String(dep._id));

        if (sendNotification) {
          const displayDecimals = tokenInfo.display_decimals ?? tokenInfo.decimals ?? 2;
          const formattedValue = value.toFixed(displayDecimals);

          await sendReceivedExternalTransferNotification(
            dep.from,
            null,
            user.phone_number,
            formattedValue,
            tokenInfo.symbol,
            ''
          );

          Logger.debug(
            'processAlchemyExternalDeposit',
            `Notification sent successfully for deposit ${dep.txHash} to user ${user.phone_number}`
          );
        }

        return { inserted: acc.inserted + 1, skipped: acc.skipped };
      } catch (error) {
        Logger.error(
          'processAlchemyExternalDeposit',
          `Error processing deposit ${dep.txHash}`,
          (error as Error).message
        );
        return acc;
      }
    },
    Promise.resolve({ inserted: 0, skipped: 0 })
  );

  return `Processed external deposits (alchemy). Inserted: ${totals.inserted}. Skipped: ${totals.skipped}.`;
};

/**
 * Processes a single external deposit detected via **The Graph** subgraph.
 *
 * This function handles deposits obtained from on-chain event indexing through The Graph,
 * transforming them into `transactions` entries used by the ChatterPay ecosystem.
 *
 * Business rules:
 * - Validates that the referenced token exists and is active for the current chain.
 * - Matches the recipient address (`transfer.to`) to a registered user via `wallets.wallet_proxy` (case-insensitive).
 * - Extracts the actual transaction hash from `transfer.id` (first 66 characters, `0x` + 64 hex digits).
 * - Converts the raw `transfer.value` to a human-readable amount using the token's decimals.
 * - Inserts the transaction with `type: "deposit"` and `status: "completed"`.
 * - Optionally sends a notification to the recipient if `sendNotification` is enabled.
 * - Skips processing if no user is found or if the token is not recognized.
 *
 * @async
 * @param {Transfer} transfer - The raw transfer object obtained from The Graph query.
 * @param {number} chanId - The blockchain network ID where the transfer occurred.
 * @param {boolean} sendNotification - Whether to send a deposit notification to the matched user.
 * @returns {Promise<void>} Resolves when processing is completed; logs warnings for skipped deposits.
 */
async function processTheGraphExternalDeposit(
  transfer: Transfer,
  chanId: number,
  sendNotification: boolean
) {
  try {
    // Normalize addresses
    const normalizedFrom = transfer.from.toLowerCase();
    const normalizedTo = transfer.to.toLowerCase();
    const txHash = transfer.transactionHash;

    // Skip if sender is a ChatterPay user (internal transfer)
    const senderCandidates = await UserModel.find({
      'wallets.wallet_proxy': { $regex: new RegExp(`^${normalizedFrom}$`, 'i') }
    });
    const isInternalSender = senderCandidates.some((u) =>
      u.wallets.some((w) => w.wallet_proxy?.toLowerCase() === normalizedFrom)
    );
    if (isInternalSender) {
      Logger.info(
        'processExternalDeposit',
        `Skipping internal transfer between ChatterPay users: ${transfer.from} → ${transfer.to}, hash: ${transfer.transactionHash}`
      );
      return;
    }

    // First validate if the token is listed and active
    const tokenObject = await mongoTokenService.getToken(transfer.token, chanId);
    if (!tokenObject) {
      Logger.info(
        'processExternalDeposit',
        `External Deposit transaction rejected: Token ${transfer.token} is not listed for chain ${chanId}`
      );
      return;
    }

    // Skip if transaction already exists
    const already = await mongoTransactionService.existsByHash(txHash);
    if (already) {
      Logger.debug('processExternalDeposit', `Skipping existing transaction ${txHash}`);
      return;
    }

    // Find users with at least one wallet_proxy that matches (case-insensitive)
    const candidates = await UserModel.find({
      'wallets.wallet_proxy': { $regex: new RegExp(`^${normalizedTo}$`, 'i') }
    });

    // Filter in memory to ensure exact lowercase match
    const user = candidates.find((u) =>
      u.wallets.some((w) => w.wallet_proxy && w.wallet_proxy.toLowerCase() === normalizedTo)
    );

    if (!user) {
      Logger.info(
        'processExternalDeposit',
        `No user found with wallet: ${transfer.to}. Transfer not processed: ${txHash}`
      );
      return;
    }

    // Get token info
    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
    const blockchainTokens = await Token.find({ chain_id: chanId });
    const tokenInfo: IToken | undefined = getTokenInfo(
      networkConfig,
      blockchainTokens,
      transfer.token
    );

    if (!tokenInfo) {
      Logger.info('processExternalDeposit', `Token info not found for address: ${transfer.token}`);
      return;
    }

    Logger.info(
      'processExternalDeposit',
      `Processing external deposit for user: ${transfer.to}. Transfer: ${JSON.stringify(transfer)}`
    );

    const valuAmount = Number((Number(transfer.value) / 10 ** tokenObject.decimals).toFixed(4));
    const transactionData: TransactionData = {
      tx: txHash,
      walletFrom: getAddress(transfer.from),
      walletTo: getAddress(transfer.to),
      amount: valuAmount,
      fee: 0,
      token: tokenInfo.symbol,
      type: 'deposit',
      status: 'completed',
      chain_id: chanId,
      date: new Date(Number(transfer.blockTimestamp) * 1000)
    };
    await mongoTransactionService.saveTransaction(transactionData);

    if (sendNotification) {
      const displayDecimals = tokenInfo.display_decimals ?? tokenInfo.decimals ?? 2;
      const formattedValue = valuAmount.toFixed(displayDecimals);

      await sendReceivedExternalTransferNotification(
        transfer.from,
        null,
        user.phone_number,
        formattedValue,
        tokenInfo.symbol,
        ''
      );
      Logger.debug(
        'processExternalDeposit',
        `Notification sent successfully for transfer ${txHash} to user ${user.phone_number}`
      );
    }
  } catch (error) {
    Logger.error('processExternalDeposit', `transfer: ${JSON.stringify(transfer)}`, error);
    // avoid throw
  }
}

/**
 * Fetches and processes external deposits detected through **The Graph** subgraph integration.
 *
 * This function queries the configured GraphQL endpoint to retrieve recent transfer events,
 * filters out internal protocol transactions (Uniswap router and pool addresses), and delegates
 * processing of each valid deposit to `processTheGraphExternalDeposit()`.
 *
 * Business rules:
 * - Executes only when the active external deposits provider is **The Graph**.
 * - Skips execution entirely when `EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY` is enabled.
 * - Reads the last processed block timestamp from the `Blockchain` document to avoid duplicates.
 * - Fetches new transfers via `THE_GRAPH_QUERY_EXTERNAL_DEPOSITS` using pagination variables.
 * - Filters out transfers originating from router or pool addresses.
 * - Persists updates to `blockchain.externalDeposits.lastBlockProcessed` after successful sync.
 *
 * @async
 * @param {string} routerAddress - Uniswap V2 router address, used to exclude internal transfers.
 * @param {string} poolAddress - Uniswap V3 pool address, used to exclude internal transfers.
 * @param {number} chainId - Blockchain network ID to process.
 * @param {boolean} sendNotification - Whether to send deposit notifications for matched users.
 * @returns {Promise<string>} Summary message indicating blocks or deposits processed.
 */
async function processThegraphExternalDeposits(
  routerAddress: string,
  poolAddress: string,
  chainId: number,
  sendNotification: boolean
) {
  // Guard: Only process if The Graph is the active provider
  if (EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY) {
    const message = `External deposits processing skipped - provider is ${EXTERNAL_DEPOSITS_PROVIDER}`;
    Logger.warn('processThegraphExternalDeposits', message);
    return message;
  }

  try {
    const blockchain = await Blockchain.findOne({ chainId });

    if (!blockchain) {
      const message = `No network found for chain_id ${chainId}`;
      Logger.error('processThegraphExternalDeposits', message);
      return message;
    }

    if (!blockchain.externalDeposits) {
      const message = `Missing externalDeposits structure in bdd for network ${chainId}`;
      Logger.error('processThegraphExternalDeposits', message);
      return message;
    }

    const fromTimestamp = blockchain.externalDeposits?.lastBlockTimestampProcessed || 0;
    const lastBlock = blockchain.externalDeposits.lastBlockProcessed || 'N/A';
    const variables = { lastTimestamp: fromTimestamp };

    // Inline formatter just for consistent log messages
    const fmt = (action: string, count: number, block: number | string, ts: number) =>
      `${action}${count ? ` ${count} external deposits` : ''}:
  - Last block processed: ${block}
  - Last timestamp (epoch): ${ts}
  - Last timestamp (UTC): ${new Date(ts * 1000).toISOString()}
  - Network chainId: ${chainId}`;

    Logger.log(
      'processThegraphExternalDeposits',
      `Fetching network (${chainId}), fromTimestamp: ${fromTimestamp}, variables: ${JSON.stringify(variables)}`
    );

    // Execute the GraphQL query
    let requestOptions: Record<string, string> | undefined;

    if (THE_GRAPH_API_KEY) {
      requestOptions = {
        Authorization: `Bearer ${THE_GRAPH_API_KEY}`
      };
    }

    const data = await request<{ chatterPayTransfers: Transfer[] }>(
      THE_GRAPH_EXTERNAL_DEPOSITS_URL,
      THE_GRAPH_QUERY_EXTERNAL_DEPOSITS,
      variables,
      requestOptions
    );

    // Filter out Uniswap V2 router transfers & Uniswap V3 Pool transfers.
    const externalDeposits = data.chatterPayTransfers.filter(
      (transfer) =>
        transfer.from.toLowerCase() !== routerAddress.toLowerCase() &&
        transfer.from.toLowerCase() !== poolAddress.toLowerCase()
    );

    // Process each external deposit
    await Promise.all(
      externalDeposits.map((transfer) =>
        processTheGraphExternalDeposit(transfer, chainId, sendNotification)
      )
    );

    let finalMsg = fmt('No new deposits found since', 0, lastBlock, fromTimestamp);

    if (externalDeposits.length > 0) {
      const maxTimestampProcessed = Math.max(
        ...externalDeposits.map((t) => parseInt(t.blockTimestamp, 10))
      );
      const maxBlockProcessed = Math.max(
        ...externalDeposits.map((t) => parseInt(t.blockNumber, 10))
      );

      blockchain.externalDeposits.lastBlockProcessed = maxBlockProcessed;
      blockchain.externalDeposits.lastBlockTimestampProcessed = maxTimestampProcessed;
      blockchain.externalDeposits.updatedAt = new Date();
      await blockchain.save();

      finalMsg = fmt(
        'Processed',
        externalDeposits.length,
        maxBlockProcessed,
        maxTimestampProcessed
      );
      Logger.info('processThegraphExternalDeposits', finalMsg);
      return finalMsg;
    }

    Logger.info('processThegraphExternalDeposits', finalMsg);
    return finalMsg;
  } catch (error) {
    Logger.error('processThegraphExternalDeposits', `Error fetching external deposits: ${error}`);
    return `Error fetching external deposits: ${error}`;
  }
}

/**
 * Entry point for **external deposits synchronization** across providers.
 *
 * This orchestrator dynamically selects which data source to use for processing deposits:
 * - When `EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY` is `true`, it executes `processAlchemyExternalDeposits()`
 *   to synchronize deposits stored in the local `external_deposits` collection populated by Alchemy webhooks.
 * - Otherwise, it invokes `processThegraphExternalDeposits()` to fetch and process deposits
 *   directly from The Graph subgraph endpoint (deprecated flow).
 *
 * Business rules:
 * - Provides a unified interface for the controller layer, abstracting the active provider.
 * - Logs which provider is being used for transparency and debugging.
 * - Handles unexpected errors gracefully and returns a summary message instead of throwing.
 *
 * @async
 * @param {string} routerAddress - Uniswap V2 router address (used only by The Graph provider).
 * @param {string} poolAddress - Uniswap V3 pool address (used only by The Graph provider).
 * @param {number} chainId - The blockchain network identifier to process.
 * @param {boolean} sendNotification - Whether to send notifications for new deposits.
 * @returns {Promise<string>} Summary message describing which provider was executed and the result.
 */
export async function fetchExternalDeposits(
  routerAddress: string,
  poolAddress: string,
  chainId: number,
  sendNotification: boolean
): Promise<string> {
  try {
    if (EXTERNAL_DEPOSITS_PROVIDER_IS_ALCHEMY) {
      Logger.info('fetchExternalDeposits', `Using Alchemy as external deposits provider.`);
      return await processAlchemyExternalDeposits(chainId, sendNotification);
    }

    Logger.info('fetchExternalDeposits', `Using The Graph as external deposits provider.`);
    return await processThegraphExternalDeposits(
      routerAddress,
      poolAddress,
      chainId,
      sendNotification
    );
  } catch (error) {
    Logger.error('fetchExternalDeposits', 'Unhandled error:', (error as Error).message);
    return `Error while fetching external deposits: ${(error as Error).message}`;
  }
}
