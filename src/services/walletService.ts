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
  const symbol: string = await tokenContract.symbol();
  console.log(
    `Checking balance for ${walletAddress} and token ${tokenContract.address}, to spend: ${amountToCheck} ${symbol}`
  );
  const walletBalance = await tokenContract.balanceOf(walletAddress);
  const decimals = await tokenContract.decimals();
  const amountToCheckFormatted = ethers.utils.parseUnits(amountToCheck, decimals);
  const walletBalanceFormatted = ethers.utils.formatEther(walletBalance);

  console.log(`Balance of wallet ${walletAddress}: ${walletBalanceFormatted} ${symbol}`);

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
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
  ];

  const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, provider);
  return verifyWalletBalance(tokenContract, walletAddress, amountToCheck);
}
