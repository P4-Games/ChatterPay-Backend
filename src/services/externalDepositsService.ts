import { gql, request } from 'graphql-request';

import { UserModel } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { TransactionData } from '../types/commonType';
import { LastProcessedBlock } from '../models/lastProcessedBlockModel';
import { sendReceivedTransferNotification } from './notificationService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { GRAPH_API_USDT_URL, GRAPH_API_WETH_URL } from '../config/constants';

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
async function processExternalDeposit(
  transfer: Transfer & { token: string },
  token: string,
  chain_id: number
) {
  const user = await UserModel.findOne({ wallet: { $regex: new RegExp(`^${transfer.to}$`, 'i') } });

  if (user) {
    const value = Number((Number(transfer.value) / 1e18).toFixed(4));

    Logger.log('processExternalDeposit', 'Updating swap transactions in database.');
    const transactionData: TransactionData = {
      tx: transfer.id,
      walletFrom: transfer.from,
      walletTo: transfer.to,
      amount: value,
      token,
      type: 'deposit',
      status: 'completed',
      chain_id
    };
    await mongoTransactionService.saveTransaction(transactionData);

    // Send incoming transfer notification message, and record tx data
    await sendReceivedTransferNotification(
      user.phone_number,
      user.name,
      transfer.to,
      value.toString(),
      token
    );
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
  routerAddress: string,
  chain_id: number
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
        'wallets.chain_id': chain_id
      },
      {
        'wallets.wallet_proxy': 1,
        'wallets.chain_id': 1
      }
    );
    Logger.log('fetchExternalDeposits', users);

    const ecosystemAddresses = users.flatMap((user) =>
      user.wallets.map((wallet) => wallet.wallet_proxy.toLowerCase())
    );

    // Prepare variables for the GraphQL query
    const variables = {
      blockNumber: fromBlock,
      receivers: ecosystemAddresses
    };
    Logger.log(
      'fetchExternalDeposits',
      `Fetching chain_id ${chain_id}, fromBlock: ${fromBlock}, users ${JSON.stringify(users)}, variables: ${JSON.stringify(variables)}`
    );

    // Execute the GraphQL queries for both USDT and WETH
    const [dataUSDT, dataWETH] = await Promise.all([
      request<{ transfers: Transfer[] }>(GRAPH_API_USDT_URL, QUERY_EXTERNAL_DEPOSITS, variables),
      request<{ transfers: Transfer[] }>(GRAPH_API_WETH_URL, QUERY_EXTERNAL_DEPOSITS, variables)
    ]);

    // Combine and filter out internal transfers and Uniswap V3 router transfers
    const allTransfers = [
      ...dataUSDT.transfers.map((t) => ({ ...t, token: 'USDT' })),
      ...dataWETH.transfers.map((t) => ({ ...t, token: 'WETH' }))
    ];
    const externalDeposits = allTransfers.filter(
      (transfer) =>
        !ecosystemAddresses.includes(transfer.from.toLowerCase()) &&
        transfer.from.toLowerCase() !== routerAddress.toLowerCase()
    );

    // Process each external deposit
    await Promise.all(
      externalDeposits.map((transfer) => processExternalDeposit(transfer, transfer.token, chain_id))
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
    Logger.error('fetchExternalDeposits', `Error fetching external deposits: ${error}`);
    return `Error fetching external deposits: ${error}`;
  }
}
