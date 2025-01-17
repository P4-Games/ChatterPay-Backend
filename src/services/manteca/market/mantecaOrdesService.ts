import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';
import { MantecaPair, MantecaLock, MantecaOrder } from '../../../types/mantecaType';

export const mantecaOrdersService = {
  /**
   * Fetches all orders made by the company.
   *
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} An object containing pagination info and a list of orders made by the company.
   *
   * @example
   * {
   *   "totalCount": 41,
   *   "pageCount": 10,
   *   "pageSize": 10,
   *   "page": 1,
   *   "lastPage": 5,
   *   "data": [
   *     {
   *       "coin": "USDC_ARS",
   *       "operation": "SELL",
   *       "coinValue": "869.826",
   *       "amount": "15",
   *       "status": "COMPLETED",
   *       "coinValueLC": "869.826",
   *       "coinValueArs": "869.826",
   *       "creationTime": "2023-12-27T15:50:41.937Z",
   *       "fee": null,
   *       "numberId": "100004664",
   *       "user": {
   *         "cuit": "20380290554",
   *         "name": "John Smith",
   *         "numberId": "35"
   *       }
   *     }
   *   ]
   * }
   */

  getOrders: async (): Promise<{
    totalCount: number;
    pageCount: number;
    pageSize: number;
    page: number;
    lastPage: number;
    data: MantecaOrder[];
  }> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/order/all`, getMantecaAxiosConfig());
      return response.data;
    } catch (error) {
      Logger.error('getOrders', error);
      throw error;
    }
  },
  /**
   * Fetches an order by its unique ID.
   *
   * @param {string} orderId - The ID of the order to fetch.
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} The details of the specified order.
   *
   * @example
   * {
   *   "numberId": "100004519",
   *   "user": {
   *     "userId": "35"
   *   },
   *   "coin": "USDC_USDT",
   *   "operation": "BUY",
   *   "coinValue": "1.005",
   *   "amount": "10",
   *   "status": "COMPLETED",
   *   "coinValueArs": "910",
   *   "creationTime": "2023-12-06T14:08:28.603Z",
   *   "fee": 0.9
   * }
   */ getOrderById: async (orderId: string): Promise<MantecaOrder> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/order/${orderId}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getOrderById', error);
      throw error;
    }
  },
  /**
   * Fetches all available cryptocurrency pairs for trading.
   *
   * @param {string} apiKey - The API key for authentication.
   * @returns {array} A list of available pairs, including both crypto-to-crypto and crypto-to-fiat pairs.
   *
   * @example
   * [
   *   {
   *     "coin": "DAI_ARS",
   *     "decimals": 2,
   *     "minSize": "0.1"
   *   },
   *   {
   *     "coin": "DAI_USD",
   *     "decimals": 3,
   *     "minSize": "0.1"
   *   }
   * ]
   */

  getAvailablePairs: async (): Promise<MantecaPair[]> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/order/coins`, getMantecaAxiosConfig());
      return response.data;
    } catch (error) {
      Logger.error('getAvailablePairs', error);
      throw error;
    }
  },
  /**
   * Creates a price lock for an order, which is required before placing the order.
   *
   * @param {string} coin - The coin pair for which the lock is to be created.
   * @param {string} operation - The operation type (e.g., "BUY" or "SELL").
   * @param {string} userId - The ID of the user placing the order.
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} An object containing the lock code, price, and expiration time.
   *
   * @example
   * {
   *   "code": "5a2e2bbdd618b8bc52c7...",
   *   "price": "1.005",
   *   "expires": "1701871502"
   * }
   */
  createOrderLock: async (
    coin: string,
    operation: string,
    userId: string
  ): Promise<MantecaLock> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/order/lock`,
        { coin, operation, userId },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('createOrderLock', error);
      throw error;
    }
  },

  /**
   * Creates an order for a user after a price lock has been created.
   *
   * @param {string} userId - The ID of the user making the order.
   * @param {number} amount - The amount of the asset to buy or sell.
   * @param {string} coin - The coin pair for the order (e.g., "USDC_USDT").
   * @param {string} operation - The operation type (e.g., "BUY" or "SELL").
   * @param {string} code - The lock code for the price lock.
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} An object containing the details of the created order.
   *
   * @example
   * {
   *   "numberId": "100004519",
   *   "user": {
   *     "userId": "35"
   *   },
   *   "coin": "USDC_USDT",
   *   "operation": "BUY",
   *   "coinValue": "1.005",
   *   "amount": "10",
   *   "status": "COMPLETED",
   *   "coinValueArs": "910",
   *   "creationTime": "2023-12-06T14:08:28.603Z",
   *   "fee": 0.9
   * }
   */
  createOrder: async (
    userId: string,
    amount: string,
    coin: string,
    operation: string,
    code: string
  ): Promise<MantecaOrder> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/order`,
        { userId, amount, coin, operation, code },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('createOrder', error);
      throw error;
    }
  }
};
