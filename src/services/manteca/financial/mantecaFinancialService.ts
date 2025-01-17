import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';
import {
  MantecaBalance,
  MantecaCompanyDebt,
  MantecaUserBalance,
  MantecaCompanyCredit
} from '../../../types/mantecaType';

export const mantecaFinancialService = {
  /**
   * Fetches the company's balance.
   *
   * @returns {Promise<MantecaBalance>} Company's balance object.
   * @example
   * {
   *   "crypto": {
   *     "USDT": { "wei": "1099009618000000000000001000", "human": "1099009618.000000000000001000" },
   *     "ETH": { "wei": "610000000000000000", "human": "0.610000000000000000" },
   *     "BTC": { "wei": "110000000000000000000", "human": "110.000000000000000000" },
   *     "MATIC": { "wei": "100000000000000000000", "human": "100.000000000000000000" },
   *     "USDC": { "wei": "-3000000000000000000", "human": "-3.000000000000000000" }
   *   },
   *   "fiat": {
   *     "ARS": { "human": "-446223.610000000000000000" },
   *     "USD": { "human": "9990.000000000000000000" }
   *   }
   * }
   */
  async getCompanyBalance(): Promise<MantecaBalance> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/company/accounting/balance`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getCompanyBalance', error);
      throw error;
    }
  },

  /**
   * Fetches the company's debt.
   *
   * @returns {Promise<MantecaCompanyDebt>} Company's debt object.
   * @example
   * {
   *   "crypto": {
   *     "USDT": { "wei": "20000000000000000000", "human": "20.000000000000000000" },
   *     "USDC": { "wei": "3000000000000000000", "human": "3.000000000000000000" }
   *   },
   *   "fiat": {
   *     "ARS": { "human": "604692.960000000000000000" }
   *   }
   * }
   */
  async getCompanyDebt(): Promise<MantecaCompanyDebt> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/company/accounting/debt`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getCompanyDebt', error);
      throw error;
    }
  },

  /**
   * Fetches the company's credit.
   *
   * @returns {Promise<MantecaCompanyCredit>} Company's credit object.
   * @example
   * {
   *   "crypto": {
   *     "USDT": { "wei": "1099009664951005000000001000", "human": "1099009664.951005000000001000" },
   *     "ETH": { "wei": "610000000000000000", "human": "0.610000000000000000" },
   *     "BTC": { "wei": "110010000000000000000", "human": "110.010000000000000000" },
   *     "MATIC": { "wei": "100000000000000000000", "human": "100.000000000000000000" },
   *     "USDC": { "wei": "40000000000000000000", "human": "40.000000000000000000" }
   *   },
   *   "fiat": {
   *     "ARS": { "human": "167199.350000000000000000" },
   *     "USD": { "human": "9990.000000000000000000" }
   *   }
   * }
   */
  async getCompanyCredit(): Promise<MantecaCompanyCredit> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/company/accounting/credit`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getCompanyCredit', error);
      throw error;
    }
  },

  /**
   * Fetches the accumulated balance of all users in the company.
   *
   * @returns {Promise<MantecaUserBalance>} Accumulated user balances object.
   * @example
   * {
   *   "fiat": {
   *     "GTQ": { "amount": 100000 },
   *     "ARS": { "amount": 1097205740 }
   *   },
   *   "crypto": {
   *     "POL": { "amount": 10 },
   *     "USDT": { "amount": 2905.4828709999997 },
   *     "USDC": { "amount": 2.5129774 }
   *   }
   * }
   */
  async getUserBalances(): Promise<MantecaUserBalance> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/company/passive`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getUserBalances', error);
      throw error;
    }
  }
};
