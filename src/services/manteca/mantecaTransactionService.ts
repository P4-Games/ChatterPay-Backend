import axios from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../config/constants';
import { getMantecaAxiosConfig } from './mantecaCommonService';
import {
  MantecaTransaction,
  MantecaSupportedAssets,
  MantecaTransactionLockResponse,
  MantecaTransactionWithdrawResponse
} from '../../types/manteca';

export const fiatTransactions = {
  /**
   * Fetches deposits associated with the company or a specific user.
   * @param userId - Optional user ID to filter deposits by a specific user.
   * @param page - The page number for paginated results.
   * @param limit - The number of items per page.
   * @param startDate - The start date for filtering in ISO8601 format.
   * @param endDate - The end date for filtering in ISO8601 format.
   * @returns An object containing the total count, page count, and the list of deposits.
   *
   * @example
   * {
   *   "totalCount": 1,
   *   "pageCount": 1,
   *   "pageSize": 10,
   *   "page": 1,
   *   "lastPage": 1,
   *   "data": [
   *     {
   *       "bankId": "test",
   *       "status": "ASSIGNED",
   *       "amount": "1000000",
   *       "coin": "ARS",
   *       "creationTime": "2024-07-23T19:19:02.936Z",
   *       "user": {
   *         "cuit": "23606200211",
   *         "name": "John Smith",
   *         "numberId": "100002481"
   *       }
   *     }
   *   ]
   * }
   */
  getDeposits: async (
    userId?: string,
    page: number = 1,
    limit: number = 10,
    startDate?: string,
    endDate?: string
  ) => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/fiat/deposit/`, {
        params: {
          userId,
          page: page.toString(),
          limit: limit.toString(),
          startDate,
          endDate
        },
        ...getMantecaAxiosConfig()
      });
      return response.data;
    } catch (error) {
      Logger.error('getDeposits', error);
      throw error;
    }
  },

  /**
   * Fetches withdrawals associated with the company or a specific user.
   * @param userId - Optional user ID to filter withdrawals by a specific user.
   * @param page - The page number for paginated results.
   * @param limit - The number of items per page.
   * @param startDate - The start date for filtering in ISO8601 format.
   * @param endDate - The end date for filtering in ISO8601 format.
   * @returns An object containing the total count, page count, and the list of withdrawals.
   *
   * @example
   * {
   *   "totalCount": 1,
   *   "pageCount": 1,
   *   "pageSize": 10,
   *   "page": 1,
   *   "lastPage": 1,
   *   "data": [
   *     {
   *       "bankId": "100000373",
   *       "status": "EXECUTED",
   *       "amount": "100.00",
   *       "numberId": "100000373",
   *       "coin": "ARS",
   *       "destAccount": {
   *         "description": "banco galicia",
   *         "cbu": "banco.galicia.ars"
   *       },
   *       "creationTime": "2024-02-19T15:53:27.085Z",
   *       "user": {
   *         "cuit": "20378442282",
   *         "name": "John Doe",
   *         "numberId": "74",
   *         "email": "user@gmail.com"
   *       },
   *       "bank": "-"
   *     }
   *   ]
   * }
   */
  getWithdrawals: async (
    userId?: string,
    page: number = 1,
    limit: number = 10,
    startDate?: string,
    endDate?: string
  ) => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/fiat/withdraw/`, {
        params: {
          userId,
          page: page.toString(),
          limit: limit.toString(),
          startDate,
          endDate
        },
        ...getMantecaAxiosConfig()
      });
      return response.data;
    } catch (error) {
      Logger.error('getWithdrawals', error);
      throw error;
    }
  },

  /**
   * Initiates a withdrawal to a specified bank account.
   * @param userId - The user ID for the withdrawal.
   * @param coin - The currency to withdraw.
   * @param cbu - The CBU (bank account number) for the destination account.
   * @param amount - The amount to withdraw.
   * @returns An array of withdrawal objects with bank details.
   *
   * @example
   * [
   *   {
   *     "bankId": "100000373",
   *     "status": "EXECUTED",
   *     "amount": "100.00",
   *     "numberId": "100000373",
   *     "coin": "ARS",
   *     "destAccount": {
   *       "description": "banco galicia",
   *       "cbu": "banco.galicia.ars"
   *     },
   *     "creationTime": "2024-02-19T15:53:27.085Z",
   *     "user": {
   *       "cuit": "20378442282",
   *       "name": "John Doe",
   *       "numberId": "74",
   *       "email": "user@gmail.com"
   *     },
   *     "bank": "-"
   *   }
   * ]
   */
  initiateWithdrawal: async (userId: string, coin: string, cbu: string, amount: string) => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/crypto/v1/fiat/withdraw`,
        {
          userId,
          coin,
          cbu,
          amount
        },
        {
          ...getMantecaAxiosConfig()
        }
      );
      return response.data;
    } catch (error) {
      Logger.error('initiateWithdrawal', error);
      throw error;
    }
  },

  /**
   * Retrieves a fiat withdrawal by its ID.
   * @param withdrawalId - The unique identifier of the withdrawal.
   * @returns An object containing the withdrawal details.
   *
   * Ejemplo de respuesta:
   * {
   *   "bankId": "100000373",
   *   "status": "EXECUTED",
   *   "amount": "100.00",
   *   "numberId": "100000373",
   *   "coin": "ARS",
   *   "destAccount": {
   *     "description": "banco galicia",
   *     "cbu": "banco.galicia.ars"
   *   },
   *   "creationTime": "2024-02-19T15:53:27.085Z",
   *   "user": {
   *     "cuit": "20378442282",
   *     "name": "John Doe",
   *     "numberId": "74",
   *     "email": "user@gmail.com"
   *   },
   *   "bank": "-"
   * }
   */
  getWithdrawalById: async (withdrawalId: string): Promise<MantecaTransaction> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/crypto/v1/fiat/withdraw/${withdrawalId}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getWithdrawalById', error);
      throw error;
    }
  }
};

export const cryptoTransactions = {
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
  ): Promise<MantecaTransactionLockResponse> => {
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
   * @returns {Promise<MantecaTransactionWithdrawResponse>} The withdrawal transaction details.
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
  ): Promise<MantecaTransactionWithdrawResponse> => {
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
