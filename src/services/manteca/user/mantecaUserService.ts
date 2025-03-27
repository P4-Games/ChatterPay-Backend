import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';
import {
  MantecaUser,
  MantecaOrder,
  MantecaUserCreate,
  MantecaBankAccount
} from '../../../types/mantecaType';

export const mantecaUserService = {
  /**
   * Create a new user.
   *
   * @param {MantecaUser} user - User data to create.
   * @returns {Promise<MantecaUser>} Created user object.
   * @example
   * {
   *   "id": "12345",
   *   "externalId": "user-12345",
   *   "firstName": "John",
   *   "lastName": "Doe",
   *   "email": "john.doe@example.com",
   *   "status": "ACTIVE"
   * }
   */
  async createUser(user: MantecaUserCreate): Promise<MantecaUser> {
    try {
      const response = await axios.post(`${MANTECA_BASE_URL}/user/`, user, getMantecaAxiosConfig());
      Logger.log('createUser', response);
      return response.data;
    } catch (error) {
      Logger.error('createUser', error);
      throw error;
    }
  },

  /**
   * Get all users with pagination.
   *
   * @param {number} [page=1] - The page number (default: 1).
   * @param {number} [limit=10] - The limit per page (default: 10).
   * @param {string} [sortBy='CREATION_TIME_DESC'] - Sort order (default: CREATION_TIME_DESC).
   * @returns {Promise<{ users: MantecaUser[]; totalCount: number }>} Paginated user list and total count.
   * @example
   * {
   *   "lastPage": 4,
   *   "page": 1,
   *   "pageCount": 10,
   *   "totalCount": 37,
   *   "users": []
   * }
   */
  async getAllUsers(
    page: number = 1,
    limit: number = 10,
    sortBy: string = 'CREATION_TIME_DESC'
  ): Promise<{ users: MantecaUser[]; totalCount: number }> {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/user/all`, {
        headers: getMantecaAxiosConfig().headers,
        params: { page, limit, sortBy }
      });
      return response.data;
    } catch (error) {
      Logger.error('getAllUsers', error);
      throw error;
    }
  },

  /**
   * Get user by any ID (numberId or externalId).
   *
   * @param {string} userAnyId - User's numberId or externalId.
   * @returns {Promise<MantecaUser>} User data.
   * @example
   * {
   *   "numberId": "100004678",
   *   "userId": "100004678",
   *   "email": "email@email.com",
   *   "cuit": "33998877662",
   *   "country": "ARGENTINA",
   *   "civilState": "SOLTERO",
   *   "name": "Nombre de usuario",
   *   "creationTime": "2024-11-26T19:54:50.203Z",
   *   "balance": {
   *     "fiat": {
   *       "ARS": { "amount": "974800.00" }
   *     },
   *     "crypto": {
   *       "WLD": { "amount": "3.0", "weiAmount": "3000000000000000000" }
   *     }
   *   },
   *   "status": "ACTIVE"
   * }
   */
  async getUserById(userAnyId: string): Promise<MantecaUser> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/user/${userAnyId}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getUserById', error);
      throw error;
    }
  },

  /**
   * Get crypto addresses for a user. If it's the first call, addresses are generated.
   *
   * @param {string} userId - Numeric ID of the user.
   * @returns {Promise<Record<string, string>>} User's crypto addresses.
   * @example
   * {
   *   "evm": "0x7c8D41358Dd0D94D8a9ad899816DD57C3e473D00",
   *   "terra": "terra1dkx6zu9s266asuazyrreev53ejnvav764s2aul"
   * }
   */
  async getCryptoAddresses(userId: string): Promise<Record<string, string>> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/user/${userId}/addresses`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getCryptoAddresses', error);
      throw error;
    }
  },

  /**
   * Get all orders of a user.
   *
   * @param {string} userId - Numeric ID of the user.
   * @returns {Promise<{ count: number; orders: MantecaOrder[] }>} User's orders.
   * @example
   * {
   *   "count": 10,
   *   "orders": [
   *     {
   *       "orderId": "210",
   *       "userId": "35",
   *       "coin": "ETH_ARS",
   *       "operation": "BUY",
   *       "coinValue": "821381.7",
   *       "amount": "0.5",
   *       "status": "COMPLETED",
   *       "creationTime": "2023-12-16T20:11:19.539Z"
   *     }
   *   ]
   * }
   */
  async getUserOrders(userId: string): Promise<{ count: number; orders: MantecaOrder[] }> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/user/${userId}/orders`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getUserOrders', error);
      throw error;
    }
  },

  /**
   * Add a bank account for a user.
   *
   * @param {string} userId - Numeric ID of the user.
   * @param {string} coin - Currency code (e.g., ARS or USD).
   * @param {MantecaBankAccount} bankData - Bank account details.
   * @returns {Promise<MantecaBankAccount>} Response of the added bank account.
   * @example
   * {
   *   "bankCode": "-",
   *   "bankName": "-",
   *   "description": "Santander Rio",
   *   "cbu": "999999999999999",
   *   "cvu": false,
   *   "actualCbu": "999999999999999"
   * }
   */
  async addBankAccount(
    userId: string,
    coin: string,
    bankData: MantecaBankAccount
  ): Promise<MantecaBankAccount> {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/user/${userId}/bankaccount/${coin}`,
        bankData,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('addBankAccount', error);
      throw error;
    }
  },

  /**
   * Delete a bank account for a user.
   *
   * @param {string} userId - Numeric ID of the user.
   * @param {string} coin - Currency code (e.g., ARS or USD).
   * @param {string} cbu - CBU or alias to delete.
   * @returns {Promise<void>} Empty response on success.
   * @example
   * {}
   */
  async deleteBankAccount(userId: string, coin: string, cbu: string): Promise<void> {
    try {
      await axios.delete(
        `${MANTECA_BASE_URL}/user/${userId}/bankaccount/${coin}/${cbu}`,
        getMantecaAxiosConfig()
      );
    } catch (error) {
      Logger.error('deleteBankAccount', error);
      throw error;
    }
  }
};
