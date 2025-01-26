import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';
import {
  MantecaTransaction,
  MantecaSupportedAssets,
  MantecaTransactionLock,
  MantecaTransactionWithdraw
} from '../../../types/mantecaType';

export const mantecaCryptoTrxsService = {
  /**
   * Fetches all transactions for a company or a specific user based on parameters.
   *
   * @param {string} userId - The ID of the user (optional).
   * @param {number} page - The page number for pagination.
   * @param {number} limit - The number of transactions to retrieve per page.
   * @param {string} type - The type of transaction (0 for DEPOSITS, 1 for WITHDRAWS).
   * @param {string} startDate - The start date in ISO8601 format.
   * @param {string} endDate - The end date in ISO8601 format.
   * @returns {Promise<Transaction[]>} An array of transactions.
   *
   * @example
   * curl --location 'https://api.manteca.dev/crypto/v1/transaction?userId=100000776&page=1&limit=10&type=1&startDate=2023-06-08&endDate=2023-06-10' \
   * --header 'md-api-key: API_KEY' \
   * --header 'Content-Type: application/json'
   */
  getTransactions: async (
    userId: string,
    page: number,
    limit: number,
    type: string,
    startDate: string,
    endDate: string
  ): Promise<MantecaTransaction[]> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/transaction`, {
        params: { userId, page, limit, type, startDate, endDate },
        ...getMantecaAxiosConfig()
      });
      return response.data.data;
    } catch (error) {
      Logger.error('getTransactions', error);
      throw error;
    }
  },

  /**
   * Retrieves a transaction by its ID.
   * @param txId - The unique identifier of the transaction.
   * @returns A Transaction object containing the transaction details.
   *
   * Ejemplo de respuesta:
   * {
   *   "from": "0xd99589F1b1695996533bB4dB43B97DD6331dBcc2",
   *   "to": "0x96c5d20b2a975c050e4220be276ace4892f4b41a",
   *   "amount": "0.099991",
   *   "hash": "100000019",
   *   "numberId": "100000019",
   *   "creationTime": "2023-06-08T19:01:16.004Z",
   *   "chain": "BINANCE",
   *   "type": "WITHDRAW",
   *   "status": "ERRORED",
   *   "coin": "BTC",
   *   "description": "No funds available",
   *   "cost": "0.000009",
   *   "user": {
   *     "name": "test",
   *     "cuit": "27048323214",
   *     "numberId": "100000776"
   *   }
   * }
   */
  getTransactionById: async (txId: string): Promise<MantecaTransaction> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/crypto/v1/transaction/${txId}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getTransactionById', error);
      throw error;
    }
  },

  /**
   * Creates a transaction lock to reserve the withdrawal cost for a user.
   *
   * @param {string} coin - The asset being withdrawn.
   * @param {string} userId - The ID of the user.
   * @param {string} chain - The blockchain chain (e.g., ETH, BSC, etc.).
   * @returns {Promise<TransactionLockResponse>} The response containing the lock details.
   *
   * @example
   * curl --location 'https://api.manteca.dev/crypto/v1/transaction/withdraw/lock' \
   * --header 'md-api-key: API_KEY' \
   * --header 'Content-Type: application/json' \
   * --data '{ "coin": "USDC", "userId": "100000718", "chain": "BASE" }'
   */
  createLockForWithdrawal: async (
    coin: string,
    userId: string,
    chain: string
  ): Promise<MantecaTransactionLock> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/crypto/v1/transaction/withdraw/lock`,
        { coin, userId, chain },
        getMantecaAxiosConfig()
      );
      return response.data.result;
    } catch (error) {
      Logger.error('createLockForWithdrawal', error);
      throw error;
    }
  },

  /**
   * Creates a withdrawal transaction after obtaining a lock.
   *
   * @param {string} coin - The asset being withdrawn.
   * @param {string} amount - The amount to withdraw.
   * @param {string} to - The recipient address.
   * @param {string} chain - The blockchain chain (e.g., ETH, BSC, etc.).
   * @param {string} userId - The ID of the user.
   * @param {string} costCode - The lock code returned from the lock creation step.
   * @returns {Promise<MantecaTransactionWithdraw>} The withdrawal transaction details.
   *
   * @example
   * curl --location 'https://api.manteca.dev/crypto/v1/transaction/withdraw' \
   * --header 'md-api-key: API_KEY' \
   * --header 'Content-Type: application/json' \
   * --data '{ "tx": { "coin": "USDC", "amount": "10000000000000000000", "to": "0x96c5d20b2a975c050e4220be276ace4892f4b41a", "chain": "BASE" }, "userId": "35", "costCode": "b8b1ec30b1788dd8f72ee3b..." }'
   */
  createWithdrawalTransaction: async (
    coin: string,
    amount: string,
    to: string,
    chain: string,
    userId: string,
    costCode: string
  ): Promise<MantecaTransactionWithdraw> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/crypto/v1/transaction/withdraw`,
        {
          tx: { coin, amount, to, chain },
          userId,
          costCode
        },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('createWithdrawalTransaction', error);
      throw error;
    }
  },

  /**
   * Fetches the supported assets for each blockchain chain.
   *
   * @returns {Promise<MantecaSupportedAssets>} The assets supported for deposits and withdrawals by each chain.
   *
   * @example
   * curl --location --request 'https://api.manteca.dev/crypto/v1/transaction/supported-assets' \
   * --header 'md-api-key: API_KEY' \
   * --header 'Content-Type: application/json'
   */
  getSupportedAssets: async (): Promise<MantecaSupportedAssets> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/crypto/v1/transaction/supported-assets`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getSupportedAssets', error);
      throw error;
    }
  }
};
