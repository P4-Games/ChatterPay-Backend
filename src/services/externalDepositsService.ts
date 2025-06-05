import { gql, request } from 'graphql-request';

import Token from '../models/tokenModel';
import { UserModel } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenInfo } from './blockchainService';
import { TransactionData } from '../types/commonType';
import { mongoTokenService } from './mongo/mongoTokenService';
import { GRAPH_API_EXTERNAL_DEPOSITS_URL } from '../config/constants';
import { LastProcessedBlock } from '../models/lastProcessedBlockModel';
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
  // Busca usuarios que tengan al menos un wallet_proxy que coincida (case-insensitive)
  const candidates = await UserModel.find({
    'wallets.wallet_proxy': { $regex: new RegExp(`^${normalizedTo}$`, 'i') }
  });
  // Filtra en memoria para asegurar coincidencia exacta en lowercase
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
      chain_id
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
 * @async
 */
export async function fetchExternalDeposits(
  networkName: string,
  routerAddress: string,
  chain_id: number
) {
  try {
    // Get the last processed timestamp
    const lastProcessedBlock = await LastProcessedBlock.findOne({
      networkName
    });
    const fromTimestamp = lastProcessedBlock ? lastProcessedBlock.blockNumber : 0;

    // Prepare variables for the GraphQL query
    const variables = {
      lastTimestamp: fromTimestamp
    };
    Logger.log(
      'fetchExternalDeposits',
      `Fetching chain_id ${chain_id}, fromTimestamp: ${fromTimestamp}, variables: ${JSON.stringify(variables)}`
    );

    // Execute the GraphQL query
    const data = await request<{ chatterPayTransfers: Transfer[] }>(
      GRAPH_API_EXTERNAL_DEPOSITS_URL,
      QUERY_EXTERNAL_DEPOSITS,
      variables
    );

    // Filter out Uniswap V3 router transfers
    const externalDeposits = data.chatterPayTransfers.filter(
      (transfer) => transfer.from.toLowerCase() !== routerAddress.toLowerCase()
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
      await LastProcessedBlock.findOneAndUpdate(
        { networkName },
        { blockNumber: maxTimestampProcessed },
        { upsert: true }
      );
      return `Processed external deposits up to timestamp ${maxTimestampProcessed}`;
    }

    return `No new deposits found since timestamp ${fromTimestamp}`;
  } catch (error) {
    Logger.error('fetchExternalDeposits', `Error fetching external deposits: ${error}`);
    return `Error fetching external deposits: ${error}`;
  }
}
