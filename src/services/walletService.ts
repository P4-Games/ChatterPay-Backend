import { ethers } from 'ethers';

/**
 * Helper function to verifiy balance in wallet
 * @param tokenContract 
 * @param walletAddress 
 * @param amountToCheck 
 * @returns 
 */
export async function verifyWalletBalance(
  tokenContract: ethers.Contract,
  walletAddress: string,
  amountToCheck: string
) {
  console.log(
    `Checking balance for ${walletAddress} and token ${tokenContract.address}, amount: ${amountToCheck}`
  );
  const walletBalance = await tokenContract.balanceOf(walletAddress);
  const decimals = await tokenContract.decimals();
  const amountToCheckFormatted = ethers.utils.parseUnits(amountToCheck, decimals);

  console.log(`Balance of ${walletAddress}: ${walletBalance}`);

  const result = {
    walletBalance,
    amountToCheck,
    enoughBalance: walletBalance.gt(amountToCheckFormatted)
  };

  return result;
}

/**
 * Helper to check token wallet balance in specific rpc 
 * @param rpcUrl 
 * @param tokenAddress 
 * @param walletAddress 
 * @param amountToCheck 
 * @returns 
 */
export async function verifyWalletBalanceInRpc(
  rpcUrl: string,
  tokenAddress: string,
  walletAddress: string,
  amountToCheck: string
) {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const erc20Abi = [
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)'
  ];

  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return verifyWalletBalance(tokenContract, walletAddress, amountToCheck);
  
}
