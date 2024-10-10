import { gql, request } from 'graphql-request';

import { User } from '../models/user';
import Transaction from '../models/transaction';
import { LastProcessedBlock } from '../models/lastProcessedBlock';
import { sendTransferNotification } from '../controllers/replyController';

/**
 * The GraphQL API URL for querying external deposits.
 */
const GRAPH_API_URL = 'https://api.studio.thegraph.com/query/91286/balance-sepolia/version/latest';

/**
 * GraphQL query to fetch external deposits.
 */
const QUERY_EXTERNAL_DEPOSITS = gql`
  query getExternalDeposits($blockNumber: Int!, $receivers: [Bytes!]!) {
    transfers(
      where: {
        blockNumber_gt: $blockNumber,
        to_in: $receivers
      },
      orderBy: blockNumber,
      orderDirection: asc,
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
export async function fetchExternalDeposits() {
  try {
    // Get the last processed block number
    const lastProcessedBlock = await LastProcessedBlock.findOne({ networkName: 'ARBITRUM_SEPOLIA' });
    const fromBlock = lastProcessedBlock ? lastProcessedBlock.blockNumber : 0;
    
    // Fetch all user wallet addresses
    const users = await User.find({}, 'wallet');
    const ecosystemAddresses = users.map(user => user.wallet.toLowerCase());

    // Prepare variables for the GraphQL query
    const variables = {
      blockNumber: fromBlock,
      receivers: ecosystemAddresses
    };

    // Execute the GraphQL query
    const data = await request<{ transfers: Transfer[] }>(GRAPH_API_URL, QUERY_EXTERNAL_DEPOSITS, variables);

    // Filter out internal transfers
    const externalDeposits = data.transfers.filter(
      transfer => !ecosystemAddresses.includes(transfer.from.toLowerCase())
    );

    // Process each external deposit
    await Promise.all(externalDeposits.map(processExternalDeposit));

    // Update the last processed block
    if (externalDeposits.length > 0) {
      const maxBlockProcessed = Math.max(...externalDeposits.map(t => t.blockNumber));
      await LastProcessedBlock.findOneAndUpdate(
        { networkName: 'ARBITRUM_SEPOLIA' },
        { blockNumber: maxBlockProcessed },
        { upsert: true }
      );
      console.log(`Procesados depósitos externos hasta el bloque ${maxBlockProcessed}`);
    } else {
      console.log(`No se encontraron nuevos depósitos desde el bloque ${fromBlock}`);
    }

  } catch (error) {
    console.error('Error fetching external deposits:', error);
  }
}

/**
 * Processes a single external deposit.
 * @async
 * @param {Transfer} transfer - The transfer object to process.
 */
async function processExternalDeposit(transfer: Transfer) {
  const user = await User.findOne({ wallet: { $regex: new RegExp(`^${transfer.to}$`, 'i') } });

  if (user) {
    const value = (Number(transfer.value) / 1e18).toFixed(2);
    
    // Send incoming transfer notification message, and record tx data
    sendTransferNotification(user.phone_number, null, value, "USDT")
    
    new Transaction({
      trx_hash: transfer.id,
      wallet_from: transfer.from,
      wallet_to: transfer.to,
      type: 'deposit',
      date: new Date(),
      status: 'completed',
      amount: value,
      token: 'USDT'
    }).save();
  } else {
    console.log(`Transfer detected, not processed: ${JSON.stringify(transfer)}`)
  }
}