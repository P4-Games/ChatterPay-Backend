import { ethers, Signer, Wallet } from 'ethers';

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
  const actualChainId = chainId ?? (await backendSigner.getChainId());

  // Create message hash using abi.encode for compatibility with Solidity
  const encodedData = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint64', 'uint256', 'address', 'bytes'],
    [
      userProxyAddress,
      expirationTimestamp,
      actualChainId,
      entryPointAddress,
      callData
    ]
  );

  const messageHash = ethers.utils.keccak256(encodedData);

  // Sign message hash
  const walletSigner = backendSigner as unknown as Wallet;
  const signature = walletSigner._signingKey().signDigest(ethers.utils.arrayify(messageHash));

  // Convert expiration to bytes8
  const expirationBytes = ethers.utils.hexZeroPad(ethers.utils.hexlify(expirationTimestamp), 8);

  // Log debugging information
  Logger.log(
    'Debugging createPaymasterAndData:',
    `
    - userProxyAddress: ${userProxyAddress}
    - expirationTimestamp: ${expirationTimestamp}
    - chainId: ${actualChainId}
    - entryPointAddress: ${entryPointAddress}
    - callData (first 100 chars): ${callData.substring(0, 100)}
    - encodedData: ${encodedData}
    - messageHash: ${messageHash}`
  );

  // Combine all components
  return ethers.utils.hexConcat([
    paymasterAddress,
    ethers.utils.joinSignature(signature),
    expirationBytes
  ]);
}