import axios from 'axios';

import { Logger } from '../../../helpers/loggerHelper';
import { MANTECA_BASE_URL } from '../../../config/constants';
import { getMantecaAxiosConfig } from '../mantecaCommonService';

export const mantecaComplianceService = {
  /**
   * Get the documentation status for a user.
   *
   * @param userId - The userId
   * @returns {Promise<{ docType: string; status: string }[]>} Documentation status data.
   *
   * @example
   * [
   *   { "docType": "DNI_FRONT", "status": "VALID" },
   *   { "docType": "DNI_BACK", "status": "PENDING" }
   * ]
   */
  async getDocumentationStatus(userId: string): Promise<{ docType: string; status: string }[]> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/documentation/status/${userId}`,
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
   *
   * @param userId - The userId
   * @param docType - Type of document ("DNI_FRONT", "DNI_BACK", "FUNDS")
   * @param fileName - Name of the file
   * @returns {Promise<{ uploadUrl: string }>} URL for file upload.
   *
   * @example
   * { "uploadUrl": "https://manteca.com/upload?docType=DNI_FRONT&userId=12345" }
   */
  async getUploadUrl(
    userId: string,
    docType: string,
    fileName: string
  ): Promise<{ uploadUrl: string }> {
    try {
      const response = await axios.post(
        `${MANTECA_BASE_URL}/documentation/${userId}/uploadUrl`,
        { docType, fileName },
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
   *
   * @param userId - The userId
   * @returns {Promise<{ validated: boolean }>} Validation status.
   *
   * @example
   * { "validated": true }
   */
  async isUserValidated(userId: string): Promise<{ validated: boolean }> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/documentation/isValidated/${userId}`,
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
   *
   * @param userId - The userId
   * @returns {Promise<{ dailyLimit: number; monthlyLimit: number }>} Limits data.
   *
   * @example
   * { "dailyLimit": 5000.0, "monthlyLimit": 20000.0 }
   */
  async getUserLimits(userId: string): Promise<{ dailyLimit: number; monthlyLimit: number }> {
    try {
      const response = await axios.get(
        `${MANTECA_BASE_URL}/documentation/${userId}/limits`,
        getMantecaAxiosConfig()
      );
      return response.data;
    } catch (error) {
      Logger.error('getUserLimits', error);
      throw error;
    }
  }
};
