import { IUser, UserModel } from '../models/userModel';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import Blockchain, { IBlockchain } from '../models/blockchainModel';

/**
 * Retrieves a user based on the phone number.
 * This function finds the user by phone number.
 *
 * @param {string} phoneNumber - The phone number of the user to retrieve.
 * @returns {Promise<IUser | null>} The user object if found, or null if not found.
 */
export const getUser = async (phoneNumber: string): Promise<IUser | null> => {
  const user: IUser | null = await UserModel.findOne({
    phone_number: getPhoneNumberFormatted(phoneNumber)
  });
  return user;
};

/**
 * Retrieves a blockchain by its chain ID.
 *
 * @param chain_id - The unique identifier of the blockchain.
 * @returns A promise that resolves to the blockchain information.
 * @throws Error if the blockchain with the specified chain ID is not found.
 */
export async function getBlockchain(chain_id: number): Promise<IBlockchain | null> {
  const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
  return blockchain;
}
