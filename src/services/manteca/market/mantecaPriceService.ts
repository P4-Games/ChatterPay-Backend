import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';
import { MantecaPrice, MantecaHistoricalPrice } from '../../../types/manteca';

export const mantecaPriceService = {
  /**
   * Fetches the current prices of available cryptocurrency pairs.
   *
   * @returns {Promise<Record<string, MantecaPrice>>} An object containing the prices of available cryptocurrency pairs.
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
  async getAllPrices(): Promise<Record<string, MantecaPrice>> {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/price`, getMantecaAxiosConfig());
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
   * @returns {Promise<MantecaPrice>} An object containing the current buy and sell prices, as well as variations for the given pair.
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
  async getPriceByPair(pair: string): Promise<MantecaPrice> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/price/${pair}`,
        getMantecaAxiosConfig()
      );
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
   * @returns {Promise<MantecaHistoricalPrice[]>} An array of historical price data points for the given pair and timeframe.
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
  async getHistoricalPrices(pair: string, timeframe: string): Promise<MantecaHistoricalPrice[]> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/price/${pair}/history?timeframe=${timeframe}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getHistoricalPrices', error);
      throw error;
    }
  }
};
