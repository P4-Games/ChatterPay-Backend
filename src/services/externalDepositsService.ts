import { gql, request } from 'graphql-request';

import { User } from '../models/user';
import Transaction from '../models/transaction';
import { Logger } from '../helpers/loggerHelper';
import { sendTransferNotification } from './notificationService';
import { LastProcessedBlock } from '../models/lastProcessedBlock';

/**
 * The GraphQL API URLs for querying external deposits.
 */
const GRAPH_API_URL_USDT =
  'https://api.studio.thegraph.com/query/91286/balance-sepolia/version/latest';
const GRAPH_API_URL_WETH =
  'https://api.studio.thegraph.com/query/91286/balance-sepolia-weth/version/latest';

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
    const users = await User.find({}, 'wallet');
    const ecosystemAddresses = users.map((user) => user.wallet.toLowerCase());

    // Prepare variables for the GraphQL query
    const variables = {
      blockNumber: fromBlock,
      receivers: ecosystemAddresses
    };

    // Execute the GraphQL queries for both USDT and WETH
    const [dataUSDT, dataWETH] = await Promise.all([
      request<{ transfers: Transfer[] }>(GRAPH_API_URL_USDT, QUERY_EXTERNAL_DEPOSITS, variables),
      request<{ transfers: Transfer[] }>(GRAPH_API_URL_WETH, QUERY_EXTERNAL_DEPOSITS, variables)
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

/**
 * Processes a single external deposit.
 * @async
 * @param {Transfer & { token: string }} transfer - The transfer object to process.
 * @param {string} token - The token type (USDT or WETH).
 */
async function processExternalDeposit(transfer: Transfer & { token: string }, token: string) {
  const user = await User.findOne({ wallet: { $regex: new RegExp(`^${transfer.to}$`, 'i') } });

  if (user) {
    const value = (Number(transfer.value) / 1e18).toFixed(4);

    // Send incoming transfer notification message, and record tx data
    sendTransferNotification(transfer.to, user.phone_number, value, token);
    new Transaction({
      trx_hash: transfer.id,
      wallet_from: transfer.from,
      wallet_to: transfer.to,
      type: 'deposit',
      date: new Date(),
      status: 'completed',
      amount: value,
      token
    }).save();
  } else {
    Logger.log(`Transfer detected, not processed: ${JSON.stringify(transfer)}`);
  }
}
