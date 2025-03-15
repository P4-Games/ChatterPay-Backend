import { ethers, BigNumber } from 'ethers';

import { Logger } from '../helpers/loggerHelper';
import { getChatterpayABI } from './web3/abiService';

/**
 * Retrieves the transaction fee from the ChatterPay contract.
 *
 * @param ChatterpayContractAddress - The address of the ChatterPay contract.
 * @param provider - An ethers.js provider to interact with the blockchain.
 * @returns A Promise resolving to the fee as a number in whole units.
 *          If an error occurs, it logs the error and returns 0.
 */
export async function getChatterpayFee(
  ChatterpayContractAddress: string,
  provider: ethers.providers.JsonRpcProvider
): Promise<number> {
  try {
    const abi = await getChatterpayABI();
    const chatterPayContract = new ethers.Contract(ChatterpayContractAddress, abi, provider);

    const chatterpayFee: BigNumber = await chatterPayContract.getFeeInCents();
    // Convert cents to whole units
    const feeInWholeUnits: number = parseFloat(chatterpayFee.toString()) / 100;
    return feeInWholeUnits;
  } catch (error) {
    // Avoid interruption due to error
    Logger.error('makeTransaction', 'Error getting ChatterPay fee:', error);
    return 0;
  }
}
