import { ethers } from 'ethers';

import { createPaymasterAndData } from '../utils/paymaster';
import { PackedUserOperation } from '../types/userOperation';

/**
 * Adds paymaster data to a UserOperation.
 */
export async function addPaymasterData(
  userOp: PackedUserOperation,
  paymasterAddress: string,
  backendSigner: ethers.Signer
): Promise<PackedUserOperation> {
  const paymasterAndData = await createPaymasterAndData(
    paymasterAddress,
    userOp.sender,
    backendSigner,
    3600 // 1 hour validity
  );
  console.log('Generated paymasterAndData:', paymasterAndData);

  return {
    ...userOp,
    paymasterAndData
  };
}

/**
 * Ensures that the paymaster has sufficient prefund with detailed logging.
 */
export async function ensurePaymasterHasPrefund(
  entrypointContract: ethers.Contract,
  paymaster: string
): Promise<void> {
  try {
    const balance = await entrypointContract.balanceOf(paymaster);

    console.log('\nChecking prefund requirements:');
    console.log(`- Current balance: ${ethers.utils.formatEther(balance)} ETH`);

    const minBalance = ethers.utils.parseEther('0.15');
    const targetBalance = ethers.utils.parseEther('0.3');

    console.log(`- Minimum required balance: ${ethers.utils.formatEther(minBalance)} ETH`);
    console.log(
      `- Target balance if deposit needed: ${ethers.utils.formatEther(targetBalance)} ETH`
    );

    if (balance.lt(minBalance)) {
      const missingFunds = targetBalance.sub(balance);
      console.log(`\nDepositing ${ethers.utils.formatEther(missingFunds)} ETH to account`);

      const tx = await entrypointContract.depositTo(paymaster, {
        value: missingFunds,
        gasLimit: 500000
      });
      await tx.wait();
      console.log('Deposit transaction confirmed');

      // Verify the new balance
      const newBalance = await entrypointContract.balanceOf(paymaster);
      console.log(`New balance after deposit: ${ethers.utils.formatEther(newBalance)} ETH`);
    } else {
      console.log('Account has sufficient prefund');
    }
  } catch (error) {
    console.error('Error ensuring paymaster has prefund:', error);
    throw error;
  }
}
