import axios from 'axios';

import { Logger } from '../../helpers/loggerHelper';

/**
 * Obtiene un archivo desde un bucket de GCP.
 *
 * @param {string} urlFile - La URL del archivo en el bucket de GCP.
 * @returns {Promise<unknown>} El contenido del archivo obtenido desde GCP.
 * @throws Lanzará un error si no se puede obtener el archivo.
 */
export const getGcpFile = async (urlFile: string): Promise<unknown> => {
  try {
    const response = await axios.get(urlFile);
    const { abi } = response.data;
    return abi;
  } catch (error) {
    Logger.error('getGcpFile', urlFile, (error as Error).message);
    throw new Error('Error obteniendo archivo de GCP');
  }
};
