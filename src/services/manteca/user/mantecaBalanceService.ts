import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MantecaUserBalance } from '../../../types/manteca';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';

export const mantecaBalanceService = {
  /**
   * Get user's current balance (both fiat and crypto).
   *
   * @param {string} userId - Numeric ID of the user.
   * @returns {Promise<MantecaUserBalance>} Current balance data.
   * @example
   * {
   *   "fiat": {
   *     "ARS": {
   *       "amount": "973800.00"
   *     }
   *   },
   *   "crypto": {
   *     "WLD": {
   *       "amount": "3.0",
   *       "weiAmount": "3000000000000000000"
   *     },
   *     "USDC": {
   *       "amount": "7.0",
   *       "weiAmount": "7000000000000000000"
   *     }
   *   },
   *   "locked": {
   *     "fiat": {
   *       "ARS": {
   *         "amount": "1000.00"
   *       }
   *     },
   *     "crypto": {}
   *   }
   * }
   */

  getUserBalance: async (userId: string): Promise<MantecaUserBalance> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/${userId}/balance`, {
        headers: getMantecaAxiosConfig().headers
      });
      return response.data;
    } catch (error) {
      Logger.error('getUserBalance', error);
      throw error;
    }
  },

  /**
   * Lock funds for a user, preventing them from being used.
   * @param userAnyId String - The user identifier (externalId or userId)
   * @param asset String - Asset type (e.g. "USDC")
   * @param amount String - Amount to lock
   * @returns Object - Response status
   * Example response:
   * {
   *   "status": "SUCCESS",
   *   "message": "Funds locked successfully"
   * }
   */
  lockUserFunds: async (
    userAnyId: string,
    asset: string,
    amount: string
  ): Promise<{ status: string; message: string }> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/balance/lock`, {
        headers: getMantecaAxiosConfig().headers,
        data: { userAnyId, asset, amount }
      });
      return response.data;
    } catch (error) {
      Logger.error('lockUserFunds', error);
      throw error;
    }
  },

  /**
   * Unlock locked funds for a user.
   * @param userAnyId String - The user identifier (externalId or userId)
   * @param asset String - Asset type (e.g. "USDC")
   * @param amount String - Amount to unlock
   * @returns Object - Response status
   * Example response:
   * {
   *   "status": "SUCCESS",
   *   "message": "Funds unlocked successfully"
   * }
   */
  unlockUserFunds: async (
    userAnyId: string,
    asset: string,
    amount: string
  ): Promise<{ status: string; message: string }> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/balance/unlock`, {
        headers: getMantecaAxiosConfig().headers,
        data: { userAnyId, asset, amount }
      });
      return response.data;
    } catch (error) {
      Logger.error('unlockUserFunds', error);
      throw error;
    }
  }
};
