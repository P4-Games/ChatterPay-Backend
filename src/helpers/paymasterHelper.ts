import { ethers, Contract, BigNumber } from 'ethers';

import { Logger } from './loggerHelper';


/**
 * Decodes and validates the paymasterAndData field
 * @param paymasterAndData - The encoded paymaster data
 * @returns Decoded components and validation status
 */
function decodePaymasterAndData(paymasterAndData: string): {
  paymasterAddress: string;
  signature: string;
  expirationTimestamp: number;
  hasExpired: boolean;
} {
  // Remove '0x' prefix if present
  const data = paymasterAndData.startsWith('0x') ? paymasterAndData.slice(2) : paymasterAndData;

  // Extract components
  const paymasterAddress = `0x${data.slice(0, 40)}`; // 20 bytes
  const signature = `0x${data.slice(40, 40 + 130)}`; // 65 bytes
  const expirationBytes = `0x${data.slice(40 + 130, 40 + 130 + 16)}`; // 8 bytes

  // Convert expiration bytes to number
  const expirationTimestamp = Number(ethers.BigNumber.from(expirationBytes));

  // Check if expired
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const hasExpired = currentTimestamp > expirationTimestamp;

  return {
    paymasterAddress,
    signature,
    expirationTimestamp,
    hasExpired
  };
}


/**
 * Creates the paymasterAndData field with required signature and expiration
 * @param paymasterAddress - Address of the paymaster contract
 * @param proxyAddress - Address of the sender (proxy)
 * @param backendSigner - Signer with the backend's private key
 * @param validityDurationSeconds - How long the signature should be valid (in seconds)
 * @returns The encoded paymasterAndData bytes
 */
export async function createPaymasterAndData(
  paymasterAddress: string,
  proxyAddress: string,
  backendSigner: ethers.Signer,
  validityDurationSeconds: number = 3600 // 1 hour default
): Promise<string> {
  // Get current timestamp and add validity duration
  const currentTimestamp = Math.floor(Date.now() / 1000); // Current time in seconds
  const expirationTimestamp = currentTimestamp + validityDurationSeconds;

  // Create message hash (proxy address + expiration timestamp)
  const messageHash = ethers.utils.solidityKeccak256(
    ['address', 'uint64'],
    [proxyAddress, expirationTimestamp]
  );

  // Sign the message
  const messageHashBytes = ethers.utils.arrayify(messageHash);
  const signature = await backendSigner.signMessage(messageHashBytes);

  // Convert expiration to bytes8 (uint64)
  const expirationBytes = ethers.utils.hexZeroPad(ethers.utils.hexlify(expirationTimestamp), 8);

  // Concatenate all components
  const paymasterAndData = ethers.utils.hexConcat([paymasterAddress, signature, expirationBytes]);

  return paymasterAndData;
}

/**
 * Verifies if the signature in paymasterAndData is valid
 * @param paymasterAndData - The encoded paymaster data
 * @param proxyAddress - The sender's proxy address
 * @param backendAddress - The expected signer's address
 * @returns Whether the signature is valid
 */
/*
export function verifyPaymasterSignature(
  paymasterAndData: string,
  proxyAddress: string,
  backendAddress: string
): boolean {
  const decoded = decodePaymasterAndData(paymasterAndData);

  // If expired, signature is invalid
  if (decoded.hasExpired) {
    return false;
  }

  // Recreate the message hash
  const messageHash = ethers.utils.solidityKeccak256(
    ['address', 'uint64'],
    [proxyAddress, decoded.expirationTimestamp]
  );

  // Verify the signature
  try {
    const messageHashBytes = ethers.utils.arrayify(messageHash);
    const recoveredAddress = ethers.utils.verifyMessage(messageHashBytes, decoded.signature);

    return recoveredAddress.toLowerCase() === backendAddress.toLowerCase();
  } catch (error) {
    Logger.error('Error verifying signature:', error);
    return false;
  }
}
*/

/**
 * Get gas limit for a transaction w/ dynamic gas.
 *
 * @param contract - Instance of the contract to call.
 * @param methodName - Name of the method to call.
 * @param args - Array of arguments for the method.
 * @param gasBufferPercentage - Percentage of gas to add to the estimated gas.
 * @param defaultGasLimit - default gas limit: 7000000 (the maximum permitted by arb).
 * @returns Gas limit for the transaction.
 * @throws Error if the method does not exist in the contract.
 * @throws Error if the gas estimation fails.
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
    const estimatedGas: BigNumber = await contract.estimateGas[methodName](...args);

    // Apply the buffer to the estimated gas
    const gasLimit: BigNumber = estimatedGas
      .mul(BigNumber.from(100 + gasBufferPercentage))
      .div(BigNumber.from(100));
    Logger.log(`Estimated gas limit for ${methodName}:`, gasLimit.toString());
    return gasLimit;
  } catch (error) {
    Logger.warn(`Gas estimation failed for ${methodName}:`, error);
    // If the estimation fails, use the default gas limit
    return defaultGasLimit;
  }
}
