import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { MantecaTransaction } from '../../../types/mantecaType';
import { getMantecaAxiosConfig } from '../mantecaCommonService';

export const mantecaFiatTrxsService = {
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
