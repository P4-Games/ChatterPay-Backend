import { DEFAULT_CHAIN_ID } from '../../config/constants';
import Blockchain, { type IBlockchain } from '../../models/blockchainModel';

export const mongoBlockchainService = {
  /**
   * Retrieves a blockchain by its chain ID.
   *
   * @param chain_id - The unique identifier of the blockchain.
   * @returns A promise that resolves to the blockchain information.
   * @throws Error if the blockchain with the specified chain ID is not found.
   */
  getBlockchain: async (chain_id: number): Promise<IBlockchain | null> => {
    const blockchain: IBlockchain | null = await Blockchain.findOne({ chainId: chain_id });
    return blockchain;
  },

  /**
   * Retrieves the network configuration for a given chain ID.
   * If no chain ID is provided, it defaults to the Scroll network (chain ID 534351).
   *
   * @param {number} [chainId=534351] - The chain ID of the network to retrieve.
   * @returns {Promise<IBlockchain>} A promise that resolves to the network configuration.
   * @throws {Error} If the network configuration is not found.
   */
  getNetworkConfig: async (chainId: number = DEFAULT_CHAIN_ID): Promise<IBlockchain> => {
    const network = await Blockchain.findOne({ chainId });
    if (!network) {
      throw new Error(`Network configuration not found for chain ID ${chainId}`);
    }
    return network;
  },

  /**
   * Retrieves all network configurations from the database.
   *
   * @returns {Promise<IBlockchain[]>} A promise that resolves to an array of all network configurations.
   */
  getAllNetworks: async (): Promise<IBlockchain[]> => Blockchain.find()
};
