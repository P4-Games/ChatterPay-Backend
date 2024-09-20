import Blockchain, { IBlockchain } from '../models/blockchain';

/**
 * Retrieves the network configuration for a given chain ID.
 * If no chain ID is provided, it defaults to the Scroll network (chain ID 534351).
 *
 * @param {number} [chainId=534351] - The chain ID of the network to retrieve.
 * @returns {Promise<IBlockchain>} A promise that resolves to the network configuration.
 * @throws {Error} If the network configuration is not found.
 */
// export async function getNetworkConfig(chainId: number = 534351): Promise<IBlockchain> {
export async function getNetworkConfig(chainId: number = 421614): Promise<IBlockchain> {
    const network = await Blockchain.findOne({ chain_id: chainId });
    if (!network) {
        throw new Error(`Network configuration not found for chain ID ${chainId}`);
    }
    return network;
}

/**
 * Retrieves all network configurations from the database.
 *
 * @returns {Promise<IBlockchain[]>} A promise that resolves to an array of all network configurations.
 */
export async function getAllNetworks(): Promise<IBlockchain[]> {
    return Blockchain.find();
}