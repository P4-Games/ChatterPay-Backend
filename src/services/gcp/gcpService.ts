import axios from 'axios';

import { Logger } from '../../helpers/loggerHelper';

/**
 * Retrieves a file from a GCP bucket.
 *
 * @param {string} urlFile - The URL of the file in the GCP bucket.
 * @returns {Promise<unknown>} The content of the file retrieved from GCP.
 * @throws Throws an error if the file cannot be retrieved.
 */
export const getGcpFile = async (urlFile: string): Promise<unknown> => {
  try {
    Logger.log('getGcpFile', `Getting file ${urlFile} from GCP bucket`);
    const response = await axios.get(urlFile);
    const { abi } = response.data;
    return abi;
  } catch (error) {
    Logger.error('getGcpFile', urlFile, (error as Error).message);
    throw new Error(`Error getting file ${urlFile} from GCP bucket`);
  }
};
