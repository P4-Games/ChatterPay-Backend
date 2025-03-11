import { ethers, Signer, Wallet, Contract, BigNumber } from 'ethers';

import { Logger } from './loggerHelper';

/**
 * Creates the paymasterAndData field with required signature and expiration
 * @param paymasterAddress - Address of the paymaster contract
 * @param userProxyAddress - Address of the sender (proxy)
 * @param backendSigner - Signer with the backend's private key
 * @param validityDurationSeconds - How long the signature should be valid (in seconds)
 * @returns The encoded paymasterAndData bytes
 */
export async function createPaymasterAndData(
  paymasterAddress: string,
  userProxyAddress: string,
  backendSigner: Signer,
  entryPointAddress: string,
  callData: string,
  validityDurationSeconds: number = 600, // 10 minutes
  chainId?: number
): Promise<string> {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const expirationTimestamp = currentTimestamp + validityDurationSeconds;

  // 1. Include chainId, entryPoint and callData in hash
  const messageHash = ethers.utils.solidityKeccak256(
    ['address', 'uint64', 'uint256', 'address', 'bytes'],
    [
      userProxyAddress,
      expirationTimestamp,
      chainId || (await backendSigner.getChainId()),
      entryPointAddress,
      callData // Key to prevent frontrunning!
    ]
  );

  // 2. Sign WITHOUT Ethereum prefix (use signDigest)
  const walletSigner = backendSigner as unknown as Wallet;
  const signature = walletSigner._signingKey().signDigest(ethers.utils.arrayify(messageHash));

  // 3. Convert expiration to bytes8
  const expirationBytes = ethers.utils.hexZeroPad(ethers.utils.hexlify(expirationTimestamp), 8);

  Logger.log(
    'createPaymasterAndData',
    `
    paymasterAddress: ${paymasterAddress},
    messageHash: ${messageHash}, 
    walletSigner: ${walletSigner.address},
    signature: ${signature.toString()},
    join-signature: ${ethers.utils.joinSignature(signature)}
    expirationBytes: ${expirationBytes}`
  );

  // 4. Concatenate components
  return ethers.utils.hexConcat([
    paymasterAddress,
    ethers.utils.joinSignature(signature),
    expirationBytes
  ]);
}

/**
 * Get gas limit for a transaction w/ dynamic gas.
 */
export async function getDynamicGas(
  contract: Contract,
  methodName: string,
  args: unknown[],
  gasBufferPercentage: number = 10,
  defaultGasLimit: BigNumber = BigNumber.from('7000000')
): Promise<BigNumber> {
  try {
    // Check if the method exists in the contract
    if (typeof contract[methodName] !== 'function') {
      throw new Error(`The method ${methodName} doesn't exist in contract.`);
    }

    // Try to estimate the gas required for the transaction
    const estimatedGas: ethers.BigNumber = await contract.estimateGas[methodName](...args);

    // Apply the buffer to the estimated gas
    const gasLimit: BigNumber = estimatedGas
      .mul(BigNumber.from(100 + gasBufferPercentage))
      .div(BigNumber.from(100));
    Logger.log('getDynamicGas', `Estimated gas limit for ${methodName}:`, gasLimit.toString());
    return gasLimit;
  } catch (error) {
    Logger.warn('getDynamicGas', `Gas estimation failed for ${methodName}:`, error);
    // If the estimation fails, use the default gas limit
    return defaultGasLimit;
  }
}
