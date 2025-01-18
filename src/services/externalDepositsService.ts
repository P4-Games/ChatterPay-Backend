import { gql, request } from 'graphql-request';

import { UserModel } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { sendTransferNotification } from './notificationService';
import { LastProcessedBlock } from '../models/lastProcessedBlockModel';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { DEFAULT_CHAIN_ID, GRAPH_API_USDT_URL, GRAPH_API_WETH_URL } from '../config/constants';

/**
 * The GraphQL API URLs for querying external deposits.
 */

/**
 * GraphQL query to fetch external deposits.
 */
const QUERY_EXTERNAL_DEPOSITS = gql`
  query getExternalDeposits($blockNumber: Int!, $receivers: [Bytes!]!) {
    transfers(
      where: { blockNumber_gt: $blockNumber, to_in: $receivers }
      orderBy: blockNumber
      orderDirection: asc
      first: 1000
    ) {
      id
      from
      to
      value
      blockNumber
      transactionHash
    }
  }
`;

/**
 * Interface representing a transfer transaction.
 */
interface Transfer {
  id: string;
  from: string;
  to: string;
  value: string;
  blockNumber: number;
  transactionHash: string;
}

/**
 * Processes a single external deposit.
 * @async
 * @param {Transfer & { token: string }} transfer - The transfer object to process.
 * @param {string} token - The token type (USDT or WETH).
 */
async function processExternalDeposit(transfer: Transfer & { token: string }, token: string) {
  const user = await UserModel.findOne({ wallet: { $regex: new RegExp(`^${transfer.to}$`, 'i') } });

  if (user) {
    const value = Number((Number(transfer.value) / 1e18).toFixed(4));

    await mongoTransactionService.saveTransaction(
      transfer.id,
      transfer.from,
      transfer.to,
      value,
      token,
      'deposit',
      'completed'
    );

    // Send incoming transfer notification message, and record tx data
    await sendTransferNotification(transfer.to, user.phone_number, value.toString(), token);
  } else {
    Logger.log(
      'processExternalDeposit',
      `Transfer detected, not processed: ${JSON.stringify(transfer)}`
    );
  }
}

/**
 * Fetches and processes external deposits for users in the ecosystem.
 * @async
 */
export async function fetchExternalDeposits(
  networkName: string,
  simpleSwapContractAddress: string
) {
  try {
    // Get the last processed block number
    const lastProcessedBlock = await LastProcessedBlock.findOne({
      networkName
    });
    const fromBlock = lastProcessedBlock ? lastProcessedBlock.blockNumber : 0;

    // Fetch all user wallet addresses
    const users = await UserModel.find(
      {
        'wallets.chain_id': DEFAULT_CHAIN_ID
      },
      'wallets.wallet_proxy'
    );
    const ecosystemAddresses = users.flatMap((user) =>
      user.wallets
        .filter((wallet) => wallet.chain_id === DEFAULT_CHAIN_ID)
        .map((wallet) => wallet.wallet_proxy.toLowerCase())
    );

    // Prepare variables for the GraphQL query
    const variables = {
      blockNumber: fromBlock,
      receivers: ecosystemAddresses
    };

    // Execute the GraphQL queries for both USDT and WETH
    const [dataUSDT, dataWETH] = await Promise.all([
      request<{ transfers: Transfer[] }>(GRAPH_API_USDT_URL, QUERY_EXTERNAL_DEPOSITS, variables),
      request<{ transfers: Transfer[] }>(GRAPH_API_WETH_URL, QUERY_EXTERNAL_DEPOSITS, variables)
    ]);

    // Combine and filter out internal transfers and SimpleSwap transfers
    const allTransfers = [
      ...dataUSDT.transfers.map((t) => ({ ...t, token: 'USDT' })),
      ...dataWETH.transfers.map((t) => ({ ...t, token: 'WETH' }))
    ];
    const externalDeposits = allTransfers.filter(
      (transfer) =>
        !ecosystemAddresses.includes(transfer.from.toLowerCase()) &&
        transfer.from.toLowerCase() !== simpleSwapContractAddress.toLowerCase()
    );

    // Process each external deposit
    await Promise.all(
      externalDeposits.map((transfer) => processExternalDeposit(transfer, transfer.token))
    );

    // Update the last processed block
    if (externalDeposits.length > 0) {
      const maxBlockProcessed = Math.max(...externalDeposits.map((t) => t.blockNumber));
      await LastProcessedBlock.findOneAndUpdate(
        { networkName: 'ARBITRUM_SEPOLIA' },
        { blockNumber: maxBlockProcessed },
        { upsert: true }
      );
      return `Processed external deposits up to block ${maxBlockProcessed}`;
    }

    return `No new deposits found since block ${fromBlock}`;
  } catch (error) {
    return `Error fetching external deposits: ${error}`;
  }
}
