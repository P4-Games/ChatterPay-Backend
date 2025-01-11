import axios from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../config/constants';
import { getMantecaAxiosConfig } from './mantecaCommonService';
import { MantecaUser, MantecaUserBalanceResponse } from '../../types/manteca';

// User Management Methods
export const userService = {
  /**
   * Create a new user.
   * @param user MantecaUser - User data to create
   * @returns MantecaUser - Created user object
   * Example response:
   * {
   *   "id": "12345",
   *   "externalId": "user-12345",
   *   "firstName": "John",
   *   "lastName": "Doe",
   *   "email": "john.doe@example.com",
   *   "status": "ACTIVE"
   * }
   */
  createUser: async (user: MantecaUser): Promise<MantecaUser> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/crypto/v1/user/`,
        user,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('createUser', error);
      throw error;
    }
  },

  /**
   * Get all users with pagination.
   * @param page Number - The page number (default: 1)
   * @param limit Number - The limit per page (default: 10)
   * @param sortBy String - Sort order for creation time (default: CREATION_TIME_DESC)
   * @returns { users: MantecaUser[], totalCount: number }
   * Example response:
   * {
   *   "users": [
   *     {
   *       "id": "12345",
   *       "externalId": "user-12345",
   *       "firstName": "John",
   *       "lastName": "Doe",
   *       "email": "john.doe@example.com",
   *       "status": "ACTIVE"
   *     },
   *     ...
   *   ],
   *   "totalCount": 100
   * }
   */
  getAllUsers: async (
    page: number = 1,
    limit: number = 10,
    sortBy: string = 'CREATION_TIME_DESC'
  ): Promise<{ users: MantecaUser[]; totalCount: number }> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/all`, {
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
   * @param userAnyId String - User's numberId or externalId
   * @returns MantecaUser - User data
   * Example response:
   * {
   *   "id": "12345",
   *   "externalId": "user-12345",
   *   "firstName": "John",
   *   "lastName": "Doe",
   *   "email": "john.doe@example.com",
   *   "status": "ACTIVE"
   * }
   */
  getUserById: async (userAnyId: string): Promise<MantecaUser> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/${userAnyId}`, {
        headers: getMantecaAxiosConfig().headers
      });
      return response.data;
    } catch (error) {
      Logger.error('getUserById', error);
      throw error;
    }
  },

  /**
   * Get user's balance (both fiat and crypto).
   * @param userId String - The userId
   * @returns MantecaUserBalanceResponse - User balance
   * Example response:
   * {
   *   "totalBalance": {
   *     "fiat": 1000.0,
   *     "crypto": 5.0
   *   },
   *   "availableBalance": {
   *     "fiat": 950.0,
   *     "crypto": 4.8
   *   }
   * }
   */
  getUserBalance: async (userId: string): Promise<MantecaUserBalanceResponse> => {
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
   * Lock user's balance (prevents them from using locked funds).
   * @returns Object - Response status
   * Example response:
   * {
   *   "status": "SUCCESS",
   *   "message": "Balance locked successfully"
   * }
   */
  lockUserBalance: async (): Promise<{ status: string; message: string }> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/balance/lock`, {
        headers: getMantecaAxiosConfig().headers
      });
      return response.data;
    } catch (error) {
      Logger.error('lockUserBalance', error);
      throw error;
    }
  },

  /**
   * Unlock user's balance (allows them to use locked funds).
   * @returns Object - Response status
   * Example response:
   * {
   *   "status": "SUCCESS",
   *   "message": "Balance unlocked successfully"
   * }
   */
  unlockUserBalance: async (): Promise<{ status: string; message: string }> => {
    try {
      const response = await axios.get(`${MANTECA_BASE_URL}/crypto/v1/user/balance/unlock`, {
        headers: getMantecaAxiosConfig().headers
      });
      return response.data;
    } catch (error) {
      Logger.error('unlockUserBalance', error);
      throw error;
    }
  }
};

// Balance Methods
export const balanceService = {
  /**
   * Get user's current balance (both fiat and crypto).
   * @param userId String - The userId
   * @returns MantecaUserBalanceResponse - Current balance data
   * Example response:
   * {
   *   "totalBalance": {
   *     "fiat": 1000.0,
   *     "crypto": 5.0
   *   },
   *   "availableBalance": {
   *     "fiat": 950.0,
   *     "crypto": 4.8
   *   }
   * }
   */
  getUserBalance: async (userId: string): Promise<MantecaUserBalanceResponse> => {
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

// Compliance Methods
export const complianceService = {
  /**
   * Get the documentation status for a user.
   * @param userId String - The userId
   * @returns Array - Documentation status data
   * Example response:
   * [
   *   {
   *     "docType": "DNI_FRONT",
   *     "status": "VALID"
   *   },
   *   {
   *     "docType": "DNI_BACK",
   *     "status": "PENDING"
   *   }
   * ]
   */
  getDocumentationStatus: async (
    userId: string
  ): Promise<{ docType: string; status: string }[]> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/crypto/v1/documentation/status/${userId}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getDocumentationStatus', error);
      throw error;
    }
  },

  /**
   * Get the upload URL for documentation.
   * @param userId String - The userId
   * @param docType String - Type of document ("DNI_FRONT", "DNI_BACK", "FUNDS")
   * @param fileName String - Name of the file
   * @returns Object - URL for file upload
   * Example response:
   * {
   *   "uploadUrl": "https://manteca.com/upload?docType=DNI_FRONT&userId=12345"
   * }
   */
  getUploadUrl: async (
    userId: string,
    docType: string,
    fileName: string
  ): Promise<{ uploadUrl: string }> => {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/crypto/v1/documentation/${userId}/uploadUrl`,
        {
          docType,
          fileName
        },
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getUploadUrl', error);
      throw error;
    }
  },

  /**
   * Check if the user is fully validated.
   * @param userId String - The userId
   * @returns Object - Validation status
   * Example response:
   * {
   *   "validated": true
   * }
   */
  isUserValidated: async (userId: string): Promise<{ validated: boolean }> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/crypto/v1/documentation/isValidated/${userId}`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('isUserValidated', error);
      throw error;
    }
  },

  /**
   * Get the limits for a user's documentation.
   * @param userId String - The userId
   * @returns Object - Limits data
   * Example response:
   * {
   *   "dailyLimit": 5000.0,
   *   "monthlyLimit": 20000.0
   * }
   */
  getUserLimits: async (userId: string): Promise<{ dailyLimit: number; monthlyLimit: number }> => {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/crypto/v1/documentation/${userId}/limits`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getUserLimits', error);
      throw error;
    }
  }
};
