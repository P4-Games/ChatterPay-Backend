import { ethers } from 'ethers';

import { Logger } from '../utils/loggerHelper';
import { PackedUserOperationType } from '../types/userOperation';
import { createPaymasterAndData } from '../utils/paymasterHelper';
import { PAYMASTER_MIN_BALANCE, PAYMASTER_TARGET_BALANCE } from '../constants/environment';

/**
 * Adds paymaster data to a UserOperation.
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

  return {
    ...userOp,
    paymasterAndData
  };
}

/**
 * Ensures that the paymaster has sufficient prefund with detailed logging.
 */
export async function ensurePaymasterHasEnoughEth(
  entrypointContract: ethers.Contract,
  paymasterContractAddress: string
): Promise<boolean> {
  try {
    const paymasterBalance = await entrypointContract.balanceOf(paymasterContractAddress);
    const minBalance = ethers.utils.parseEther(PAYMASTER_MIN_BALANCE);
    const targetBalance = ethers.utils.parseEther(PAYMASTER_TARGET_BALANCE);

    Logger.log(`Checking prefund requirements in paymaster ${paymasterContractAddress}.`);
    Logger.log(`Paymaster: current balance: ${ethers.utils.formatEther(paymasterBalance)} ETH.`);
    Logger.log(`Paymaster: minimum required balance: ${ethers.utils.formatEther(minBalance)} ETH.`);
    Logger.log(
      `Paymaster: Target balance if deposit needed: ${ethers.utils.formatEther(targetBalance)} ETH.`
    );

    if (paymasterBalance.lt(minBalance)) {
      Logger.log('Paymaster does not have sufficient prefund.');
      const missingFunds = targetBalance.sub(paymasterBalance);
      Logger.log(`Depositing ${ethers.utils.formatEther(missingFunds)} ETH to account.`);

      const tx = await entrypointContract.depositTo(paymasterContractAddress, {
        value: missingFunds,
        gasLimit: 500000
      });
      await tx.wait();
      Logger.log('Deposit transaction confirmed.');

      // Verify the new balance
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
