import axios from 'axios';
import { API_BASE_URL } from '@pushprotocol/restapi/src/lib/config';

import { getMantecaAxiosConfig } from './mantecaCommonService';
import {
  MantecaPair,
  MantecaPrice,
  MantecaOrder,
  MantecaLockResponse,
  MantecaRampOnResponse,
  MantecaHistoricalPrice,
  MantecaRampOffResponse
} from '../../types/manteca'; // Assuming you have a logger module
import { Logger } from '../../helpers/loggerHelper';

// User Management Methods
export const prices = {
  /**
   * Fetches the current prices of available cryptocurrency pairs.
   *
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} An object containing the prices of available cryptocurrency pairs.
   *
   * @example
   * {
   *   "BTC_ARS": {
   *     "coin": "BTC_ARS",
   *     "timestamp": "1701873973358",
   *     "buy": "40214902",
   *     "sell": "38447214",
   *     "variation": {
   *       "realtime": "0.000",
   *       "daily": "4.663"
   *     }
   *   },
   *   "BTC_USD": {
   *     "coin": "BTC_USD",
   *     "timestamp": "1701873973358",
   *     "buy": "47285.65",
   *     "sell": "40656.824",
   *     "variation": {
   *       "realtime": "0.000",
   *       "daily": "4.663"
   *     }
   *   }
   * }
   */
  getAllPrices: async (): Promise<Record<string, MantecaPrice>> => {
    try {
      const response = await axios.get(`${API_BASE_URL}/price`, getMantecaAxiosConfig());
      return response.data;
    } catch (error) {
      Logger.error('getAllPrices', error);
      throw error;
    }
  },

  /**
   * Fetches the current price of a specific cryptocurrency pair.
   *
   * @param {string} pair - The pair for which to retrieve the price (e.g., "USDT_ARS").
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} An object containing the current buy and sell prices, as well as variations for the given pair.
   *
   * @example
   * {
   *   "coin": "USDT_ARS",
   *   "timestamp": "1701877050491",
   *   "buy": "910",
   *   "sell": "870",
   *   "variation": {
   *     "realtime": "0.000",
   *     "daily": "-17.273"
   *   }
   * }
   */

  getPriceByPair: async (pair: string): Promise<MantecaPrice> => {
    try {
      const response = await axios.get(`${API_BASE_URL}/price/${pair}`, getMantecaAxiosConfig());
      return response.data;
    } catch (error) {
      Logger.error('getPriceByPair', error);
      throw error;
    }
  },

  /**
   * Fetches historical price data for a specified cryptocurrency pair over a given timeframe.
   *
   * @param {string} pair - The pair for which to retrieve historical data (e.g., "USDT_ARS").
   * @param {string} timeframe - The period for which to retrieve historical data (e.g., "daily").
   * @param {string} apiKey - The API key for authentication.
   * @returns {array} An array of historical price data points for the given pair and timeframe.
   *
   * @example
   * [
   *   {
   *     "coin": "USDT_ARS",
   *     "buy": "910.00000000",
   *     "sell": "870.00000000",
   *     "timestamp": "1701820810006"
   *   },
   *   {
   *     "coin": "USDT_ARS",
   *     "buy": "910.00000000",
   *     "sell": "870.00000000",
   *     "timestamp": "1701734406464"
   *   }
   * ]
   */

  getHistoricalPrices: async (
    pair: string,
    timeframe: string
  ): Promise<MantecaHistoricalPrice[]> => {
    try {
      const response = await axios.get(
        `${API_BASE_URL}/price/${pair}/history?timeframe=${timeframe}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getHistoricalPrices', error);
      throw error;
    }
  }
};

// Order Management Methods
export const orders = {
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
      const response = await axios.get(`${API_BASE_URL}/order/all`, getMantecaAxiosConfig());
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
      const response = await axios.get(`${API_BASE_URL}/order/${orderId}`, getMantecaAxiosConfig());
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
      const response = await axios.get(`${API_BASE_URL}/order/coins`, getMantecaAxiosConfig());
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
  ): Promise<MantecaLockResponse> => {
    try {
      const response = await axios.post(
        `${API_BASE_URL}/order/lock`,
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
        `${API_BASE_URL}/order`,
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

// Synthetics Management Methods
export const synthetics = {
  /**
   * Performs a ramp-on operation, which involves purchasing cryptocurrency and withdrawing it automatically.
   * The process starts once the required FIAT funds are sent to the given address.
   *
   * @param {string} externalId - The external identifier for the ramp-on operation.
   * @param {string} userAnyId - The identifier for the user initiating the operation.
   * @param {string} sessionId - The session ID for the ramp-on operation.
   * @param {string} asset - The asset to buy (e.g., "USDC").
   * @param {string} against - The currency to use for the purchase (e.g., "ARS").
   * @param {number} assetAmount - The amount of the asset to buy.
   * @param {string} priceCode - The price code for the operation.
   * @param {string} withdrawAddress - The address to withdraw the asset to.
   * @param {string} withdrawNetwork - The network for withdrawal.
   * @param {string} apiKey - The API key for authentication.
   * @returns {object} Details of the ramp-on operation, including deposit and withdrawal information.
   *
   * @example
   * {
   *   "id": "675c39a4ca5811051b7ec211",
   *   "externalId": "externalId-synth-001",
   *   "status": "PENDING",
   *   "asset": "USDC",
   *   "amount": 0.9999,
   *   "withdrawAddress": "0x3f2e9f249E19e74a23eDA48246D84D5c1f29559D",
   *   "timestamp": "2025-01-11T10:11:52",
   *   "message": "Ramp-on operation is in progress."
   * }
   */
  rampOn: async (
    externalId: string,
    userAnyId: string,
    sessionId: string,
    asset: string,
    against: string,
    assetAmount: string,
    priceCode: string,
    withdrawAddress: string,
    withdrawNetwork: string
  ): Promise<MantecaRampOnResponse> => {
    try {
      const response = await axios.post(
        `${API_BASE_URL}/synthetics/ramp-on`,
        {
          externalId,
          userAnyId,
          sessionId,
          asset,
          against,
          assetAmount,
          priceCode,
          withdrawAddress,
          withdrawNetwork
        },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('rampOn', error);
      throw error;
    }
  },

  /**
   * Performs a ramp-off operation, which involves selling cryptocurrency and withdrawing the resulting assets automatically.
   * Once the synthetic asset is created, the system will provide the crypto address to which the funds must be sent to trigger the process,
   * along with the supported networks. If insufficient funds are sent, the synthetic will not be processed.
   * If excess funds are sent, they will be processed without issue (all funds received since the creation of the synthetic).
   * For a ramp-off that accumulates funds in the user balance instead of sending them, use the alias 'partial-ramp-off',
   * where the 'withdrawAddress' field becomes optional as only the deposit and order stages will be involved.
   *
   * @param {string} externalId - The external identifier for the ramp-off operation.
   * @param {string} userAnyId - The identifier for the user initiating the operation.
   * @param {string} sessionId - The session ID for the ramp-off operation.
   * @param {string} asset - The asset to sell (e.g., "USDC").
   * @param {string} against - The currency to sell the asset against (e.g., "ARS").
   * @param {string} againstAmount - The amount of the 'against' asset involved in the transaction (e.g., "10.5 ARS").
   * @param {string} priceCode - The price code for the transaction.
   * @param {string} withdrawAddress - The address to withdraw the asset to (optional for partial ramp-off).
   * @returns {object} The details of the ramp-off operation, including deposit, order, and withdrawal information.
   *
   * @example
   * {
   *   "id": "675c4dfb7a7c317162a06bd3",
   *   "externalId": "externalId-synth-ramp-off-12",
   *   "status": "STARTING",
   *   "details": {
   *     "depositAddress": "0x701d632075ffe6D70D06bD390C979Ad7EB16Dc61",
   *     "depositAvailableNetworks": ["ETHEREUM", "BINANCE", "POLYGON", "OPTIMISM", "BASE", "ARBITRUM", "INTERNAL"],
   *     "withdrawCostInAgainst": "0",
   *     "withdrawCostInAsset": "0"
   *   },
   *   "currentStage": 1,
   *   "stages": {
   *     "1": {
   *       "stageType": "DEPOSIT",
   *       "asset": "USDC",
   *       "tresholdAmount": "10.51900785",
   *       "expireAt": "2024-12-13T17:08:43.585Z"
   *     },
   *     "2": {
   *       "stageType": "ORDER",
   *       "side": "SELL",
   *       "asset": "USDC",
   *       "against": "ARS",
   *       "assetAmount": "10.51900785",
   *       "price": "950.66"
   *     },
   *     "3": {
   *       "stageType": "WITHDRAW",
   *       "network": "MANTECA",
   *       "asset": "ARS",
   *       "amount": "10000",
   *       "to": "999999999999999"
   *     }
   *   },
   *   "creationTime": "2024-12-13T12:08:43.602-03:00",
   *   "updatedAt": "2024-12-13T12:08:43.602-03:00"
   * }
   */
  rampOff: async (
    externalId: string,
    userAnyId: string,
    sessionId: string,
    asset: string,
    against: string,
    againstAmount: string,
    priceCode: string,
    withdrawAddress: string
  ): Promise<MantecaRampOffResponse> => {
    try {
      const response = await axios.post(
        `${API_BASE_URL}/synthetics/ramp-off`,
        {
          externalId,
          userAnyId,
          sessionId,
          asset,
          against,
          againstAmount,
          priceCode,
          withdrawAddress
        },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('rampOff', error);
      throw error;
    }
  }
};
