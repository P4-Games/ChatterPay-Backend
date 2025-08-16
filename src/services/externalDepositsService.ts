import { getAddress } from 'ethers/lib/utils';
import { gql, request } from 'graphql-request';

import { UserModel } from '../models/userModel';
import { Logger } from '../helpers/loggerHelper';
import { getTokenInfo } from './blockchainService';
import Token, { IToken } from '../models/tokenModel';
import { TransactionData } from '../types/commonType';
import { mongoTokenService } from './mongo/mongoTokenService';
import Blockchain, { IBlockchain } from '../models/blockchainModel';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { sendReceivedTransferNotification } from './notificationService';
import { mongoTransactionService } from './mongo/mongoTransactionService';
import { THE_GRAPH_API_KEY, THE_GRAPH_EXTERNAL_DEPOSITS_URL } from '../config/constants';

/**
 * GraphQL query to fetch external deposits.
 */
const THE_GRAPH_QUERY_EXTERNAL_DEPOSITS = gql`
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
 * @param {number} chanId - The chain ID where the transfer occurred.
 * @param {boolean} sendNotification - Enable / Disable send external deposit notification
 */
async function processExternalDeposit(
  transfer: Transfer,
  chanId: number,
  sendNotification: boolean
) {
  try {
    // First validate if the token is listed and active
    const tokenObject = await mongoTokenService.getToken(transfer.token, chanId);

    if (!tokenObject) {
      Logger.warn(
        'processExternalDeposit',
        `External Deposit transaction rejected: Token ${transfer.token} is not listed for chain ${chanId}`
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
      Logger.debug(
        'processExternalDeposit',
        `Processing external deposit for user user: ${transfer.to}. Transfer: ${JSON.stringify(transfer)}`
      );
      const value = Number((Number(transfer.value) / 10 ** tokenObject.decimals).toFixed(4));

      // Get token info
      const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
      const blockchainTokens = await Token.find({ chain_id: chanId });
      const tokenInfo: IToken | undefined = getTokenInfo(
        networkConfig,
        blockchainTokens,
        transfer.token
      );

      if (!tokenInfo) {
        Logger.warn(
          'processExternalDeposit',
          `Token info not found for address: ${transfer.token}`
        );
        return;
      }

      Logger.debug('processExternalDeposit', 'Saving external deposit transaction in database.');

      // Some subgraphs use `id` as a composite of `txHash + logIndex`.
      // We extract only the first 66 characters to get the actual transaction hash (0x + 64 hex digits).
      const txHash = transfer.id.slice(0, 66);

      const transactionData: TransactionData = {
        tx: txHash,
        walletFrom: getAddress(transfer.from),
        walletTo: getAddress(transfer.to),
        amount: value,
        fee: 0,
        token: tokenInfo.symbol,
        type: 'deposit',
        status: 'completed',
        chain_id: chanId,
        date: new Date(Number(transfer.blockTimestamp) * 1000)
      };
      await mongoTransactionService.saveTransaction(transactionData);

      if (sendNotification) {
        await sendReceivedTransferNotification(
          transfer.to,
          null,
          user.phone_number,
          value.toString(),
          tokenInfo.symbol
        );
        Logger.debug(
          'processExternalDeposit',
          `Notification sent successfully for transfer ${txHash} to user ${user.phone_number}`
        );
      }
    } else {
      Logger.warn(
        'processExternalDeposit',
        `No user found with wallet: ${transfer.to}. Transfer not processed: ${JSON.stringify(transfer)}`
      );
    }
  } catch (error) {
    Logger.error('processExternalDeposit', `transfer: ${JSON.stringify(transfer)}`, error);
    // avoid throw
  }
}

/**
 * Fetches and processes external deposits for users in the ecosystem.
 *
 * @async
 * @param {string} routerAddress - The address of the Uniswap V2 router (used to filter internal transfers).
 * @param {string} poolAddress - The address of the Uniswap v3 Pool (used to filter internal transfers)
 * @param {number} chainId - The ID of the blockchain network being processed.
 * @param {boolean} sendNotification - Enable / Disable send external deposit notification
 * @returns {Promise<string>} A message indicating the result of the processing.
 */
export async function fetchExternalDeposits(
  routerAddress: string,
  poolAddress: string,
  chainId: number,
  sendNotification: boolean
) {
  try {
    const blockchain = await Blockchain.findOne({ chainId });

    if (!blockchain) {
      const message = `No network found for chain_id ${chainId}`;
      Logger.error('fetchExternalDeposits', message);
      return message;
    }

    if (!blockchain.externalDeposits) {
      const message = `Missing externalDeposits structure in bdd for network ${chainId}`;
      Logger.error('fetchExternalDeposits', message);
      return message;
    }

    const fromTimestamp = blockchain.externalDeposits?.lastBlockProcessed || 0;
    const variables = {
      lastTimestamp: fromTimestamp
    };

    Logger.log(
      'fetchExternalDeposits',
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
        processExternalDeposit(transfer, chainId, sendNotification)
      )
    );

    // Update the last processed Block in BDD
    let finalMsg = `No new deposits found since Block ${fromTimestamp}`;
    if (externalDeposits.length > 0) {
      const maxTimestampProcessed = Math.max(
        ...externalDeposits.map((t) => parseInt(t.blockTimestamp, 10))
      );

      blockchain.externalDeposits.lastBlockProcessed = maxTimestampProcessed;
      blockchain.externalDeposits.updatedAt = new Date();
      await blockchain.save();
      finalMsg = `Processed external deposits up to Block ${maxTimestampProcessed}`;
      Logger.info('fetchExternalDeposits', finalMsg);
      return finalMsg;
    }

    Logger.info('fetchExternalDeposits', finalMsg);
    return finalMsg;
  } catch (error) {
    Logger.error('fetchExternalDeposits', `Error fetching external deposits: ${error}`);
    return `Error fetching external deposits: ${error}`;
  }
}
