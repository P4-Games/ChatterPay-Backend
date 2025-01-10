import { ethers } from 'ethers';

import { Logger } from '../helpers/loggerHelper';
import { PackedUserOperationType } from '../types/userOperation';
import { createPaymasterAndData } from '../helpers/paymasterHelper';
import { PAYMASTER_MIN_BALANCE, PAYMASTER_TARGET_BALANCE } from '../config/constants';

/**
 * Adds paymaster-related data to the given UserOperation.
 *
 * This function computes and attaches the necessary data that the paymaster requires for the UserOperation,
 * such as the paymaster address, the sender's address, and validity period.
 *
 * @param userOp - The user operation to which the paymaster data will be added.
 * @param paymasterAddress - The address of the paymaster contract.
 * @param backendSigner - The signer that signs the paymaster data.
 * @returns A new UserOperation with the added paymaster data.
 */
export async function addPaymasterData(
  userOp: PackedUserOperationType,
  paymasterAddress: string,
  backendSigner: ethers.Signer
): Promise<PackedUserOperationType> {
  const paymasterAndData = await createPaymasterAndData(
    paymasterAddress,
    userOp.sender,
    backendSigner,
    3600 // 1 hour validity
  );
  Logger.log('Generated paymasterAndData:', paymasterAndData);

  // Return the user operation with the added paymaster data
  return {
    ...userOp,
    paymasterAndData
  };
}

/**
 * Ensures that the paymaster has enough ETH prefund for operations.
 *
 * This function checks if the paymaster has enough balance to cover the required minimum prefund
 * and deposits additional funds if necessary. It logs each action taken.
 *
 * @param entrypointContract - The contract that interacts with the paymaster.
 * @param paymasterContractAddress - The address of the paymaster contract.
 * @returns A boolean indicating whether the operation was successful.
 */
export async function ensurePaymasterHasEnoughEth(
  entrypointContract: ethers.Contract,
  paymasterContractAddress: string
): Promise<boolean> {
  try {
    // Get the current balance of the paymaster
    const paymasterBalance = await entrypointContract.balanceOf(paymasterContractAddress);
    const minBalance = ethers.utils.parseEther(PAYMASTER_MIN_BALANCE);
    const targetBalance = ethers.utils.parseEther(PAYMASTER_TARGET_BALANCE);

    Logger.log(`Checking prefund requirements in paymaster ${paymasterContractAddress}.`);
    Logger.log(`Paymaster: current balance: ${ethers.utils.formatEther(paymasterBalance)} ETH.`);
    Logger.log(`Paymaster: minimum required balance: ${ethers.utils.formatEther(minBalance)} ETH.`);
    Logger.log(
      `Paymaster: Target balance if deposit needed: ${ethers.utils.formatEther(targetBalance)} ETH.`
    );

    // If the paymaster balance is less than the minimum, perform a deposit
    if (paymasterBalance.lt(minBalance)) {
      Logger.log('Paymaster does not have sufficient prefund.');
      const missingFunds = targetBalance.sub(paymasterBalance);
      Logger.log(`Depositing ${ethers.utils.formatEther(missingFunds)} ETH to account.`);

      // Deposit funds into the paymaster
      const tx = await entrypointContract.depositTo(paymasterContractAddress, {
        value: missingFunds,
        gasLimit: 500000
      });
      await tx.wait();
      Logger.log('Deposit transaction confirmed.');

      // Verify the new balance after deposit
      const newBalance = await entrypointContract.balanceOf(paymasterContractAddress);
      Logger.log(`New balance after deposit: ${ethers.utils.formatEther(newBalance)} ETH`);
    } else {
      Logger.log('Paymaster has sufficient prefund.');
    }
    return true;
  } catch (error) {
    Logger.error('Error ensuring paymaster has prefund:', error);
    return false;
  }
}
