import { ethers } from 'ethers';

/**
 * Helper function to check balances
 */
export async function verifyWalletBalance(
  tokenContract: ethers.Contract,
  walletAddress: string,
  amountToCheck: string
) {
  console.log(
    `Checking balance for ${walletAddress} and token ${tokenContract.address}, amount: ${amountToCheck}`
  );
  const amountToCheckFormatted = ethers.utils.parseUnits(amountToCheck, 18);
  const walletBalance = await tokenContract.balanceOf(walletAddress);
  console.log(`Balance of ${walletAddress}: ${walletBalance}`);

  const result = {
    walletBalance,
    amountToCheck,
    enoughBalance: walletBalance.gt(amountToCheckFormatted)
  };

  return result;
}
