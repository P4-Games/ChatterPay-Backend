import { gql, request } from 'graphql-request';

import Token from '../models/tokenModel';
import { UserModel } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenInfo } from './blockchainService';
import Blockchain from '../models/blockchainModel';
import { TransactionData } from '../types/commonType';
import { mongoTokenService } from './mongo/mongoTokenService';
import { GRAPH_API_EXTERNAL_DEPOSITS_URL } from '../config/constants';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { sendReceivedTransferNotification } from './notificationService';
import { mongoTransactionService } from './mongo/mongoTransactionService';

/**
 * GraphQL query to fetch external deposits.
 */
const QUERY_EXTERNAL_DEPOSITS = gql`
  query getExternalDeposits($lastTimestamp: Int!) {
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
  blockTimestamp: string;
  transactionHash: string;
}

/**
 * Processes a single external deposit.
 * @async
 * @param {Transfer} transfer - The transfer object to process.
 * @param {number} chain_id - The chain ID where the transfer occurred.
 */
async function processExternalDeposit(transfer: Transfer, chain_id: number) {
  // First validate if the token is listed and active
  const tokenObject = await mongoTokenService.getToken(transfer.token, chain_id);

  if (!tokenObject) {
    Logger.warn(
      'processExternalDeposit',
      `Transfer rejected: Token ${transfer.token} is not listed for chain ${chain_id}`
    );
    return;
  }

  const normalizedTo = transfer.to.toLowerCase();

  // Find users with at least one wallet_proxy that matches (case-insensitive)
  const candidates = await UserModel.find({
    'wallets.wallet_proxy': { $regex: new RegExp(`^${normalizedTo}$`, 'i') }
  });

  // Filter in memory to ensure exact lowercase match
  const user = candidates.find((u) =>
    u.wallets.some((w) => w.wallet_proxy && w.wallet_proxy.toLowerCase() === normalizedTo)
  );

  if (user) {
    const value = Number((Number(transfer.value) / 10 ** tokenObject.decimals).toFixed(4));

    // Get token info
    const networkConfig = await mongoBlockchainService.getNetworkConfig();
    const blockchainTokens = await Token.find({ chain_id });
    const tokenInfo = getTokenInfo(networkConfig, blockchainTokens, transfer.token);

    if (!tokenInfo) {
      Logger.warn('processExternalDeposit', `Token info not found for address: ${transfer.token}`);
      return;
    }

    Logger.log('processExternalDeposit', 'Updating swap transactions in database.');
    const transactionData: TransactionData = {
      tx: transfer.id,
      walletFrom: transfer.from,
      walletTo: transfer.to,
      amount: value,
      fee: 0,
      token: tokenInfo.symbol,
      type: 'deposit',
      status: 'completed',
      chain_id,
      date: new Date(Number(transfer.blockTimestamp) * 1000)
    };
    await mongoTransactionService.saveTransaction(transactionData);

    try {
      // Send incoming transfer notification message, and record tx data
      await sendReceivedTransferNotification(
        transfer.to,
        null,
        user.phone_number,
        value.toString(),
        tokenInfo.symbol
      );
      Logger.log(
        'processExternalDeposit',
        `Notification sent successfully for transfer ${transfer.id} to user ${user.phone_number}`
      );
    } catch (error) {
      Logger.error(
        'processExternalDeposit',
        `Failed to send notification for transfer ${transfer.id}: ${error}`
      );
    }
  } else {
    Logger.warn(
      'processExternalDeposit',
      `No user found with wallet: ${transfer.to}. Transfer not processed: ${JSON.stringify(transfer)}`
    );
  }
}

/**
 * Fetches and processes external deposits for users in the ecosystem.
 *
 * @async
 * @param {string} routerAddress - The address of the Uniswap V2 router (used to filter internal transfers).
 * @param {string} poolAddress - The address of the Uniswap v3 Pool (used to filter internal transfers)
 * @param {number} chain_id - The ID of the blockchain network being processed.
 * @returns {Promise<string>} A message indicating the result of the processing.
 */
export async function fetchExternalDeposits(
  routerAddress: string,
  poolAddress: string,
  chain_id: number
) {
  try {
    const blockchain = await Blockchain.findOne({ chainId: chain_id });

    if (!blockchain) {
      const message = `No network found for chain_id ${chain_id}`;
      Logger.error('fetchExternalDeposits', message);
      return message;
    }

    if (!blockchain.externalDeposits) {
      const message = `Missing externalDeposits structure in bdd for network ${chain_id}`;
      Logger.error('fetchExternalDeposits', message);
      return message;
    }

    const fromTimestamp = blockchain.externalDeposits?.lastBlockProcessed || 0;
    const variables = {
      lastTimestamp: fromTimestamp
    };

    Logger.log(
      'fetchExternalDeposits',
      `Fetching network (${chain_id}), fromTimestamp: ${fromTimestamp}, variables: ${JSON.stringify(variables)}`
    );

    // Execute the GraphQL query
    const data = await request<{ chatterPayTransfers: Transfer[] }>(
      GRAPH_API_EXTERNAL_DEPOSITS_URL,
      QUERY_EXTERNAL_DEPOSITS,
      variables
    );

    // Filter out Uniswap V2 router transfers & Uniswap V3 pool transfers.
    const externalDeposits = data.chatterPayTransfers.filter(
      (transfer) =>
        transfer.from.toLowerCase() !== routerAddress.toLowerCase() &&
        transfer.from.toLowerCase() !== poolAddress.toLowerCase()
    );

    // Process each external deposit
    await Promise.all(
      externalDeposits.map((transfer) => processExternalDeposit(transfer, chain_id))
    );

    // Update the last processed timestamp
    if (externalDeposits.length > 0) {
      const maxTimestampProcessed = Math.max(
        ...externalDeposits.map((t) => parseInt(t.blockTimestamp, 10))
      );

      blockchain.externalDeposits.lastBlockProcessed = maxTimestampProcessed;
      blockchain.externalDeposits.updatedAt = new Date();
      await blockchain.save();
      return `Processed external deposits up to timestamp ${maxTimestampProcessed}`;
    }

    return `No new deposits found since timestamp ${fromTimestamp}`;
  } catch (error) {
    Logger.error('fetchExternalDeposits', `Error fetching external deposits: ${error}`);
    return `Error fetching external deposits: ${error}`;
  }
}
