import Blockchain, { IBlockchain } from '../models/blockchain';

/**
 * Retrieves a blockchain by its chain ID.
 *
 * @param chain_id - The unique identifier of the blockchain.
 * @returns A promise that resolves to the blockchain information.
 * @throws Error if the blockchain with the specified chain ID is not found.
 */
export async function getBlockchain(chain_id: number): Promise<IBlockchain> {
  const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
  if (!blockchain) {
    throw new Error(`Blockchain with chain_id ${chain_id} not found`);
  }
  return blockchain;
}
