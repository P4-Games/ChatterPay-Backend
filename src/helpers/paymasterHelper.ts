import { ethers, Signer, Wallet } from 'ethers';

import { Logger } from './loggerHelper';

/**
 * Creates the paymasterAndData field including authorization data and an expiration marker.
 *
 * @param paymasterAddress - Address of the paymaster contract
 * @param userProxyAddress - Address of the sender (proxy)
 * @param backPrincipal - Key holder used to generate the authorization data
 * @param entryPointAddress - Address of the entry point contract
 * @param callData - Encoded call data of the user operation
 * @param validityDurationSeconds - Duration for which the authorization remains valid (in seconds)
 * @param chainId - Optional chain identifier for network context
 * @returns The encoded paymasterAndData bytes
 */
export async function createPaymasterAndData(
  paymasterAddress: string,
  userProxyAddress: string,
  backPrincipal: Signer,
  entryPointAddress: string,
  callData: string,
  validityDurationSeconds: number = 600,
  chainId?: number
): Promise<string> {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const expirationTimestamp = currentTimestamp + validityDurationSeconds;
  const actualChainId = chainId ?? (await backPrincipal.getChainId());

  const encodedData = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint64', 'uint256', 'address', 'bytes'],
    [userProxyAddress, expirationTimestamp, actualChainId, entryPointAddress, callData]
  );

  const messageHash = ethers.utils.keccak256(encodedData);
  const wSig = backPrincipal as unknown as Wallet;
  const sig = wSig._signingKey().signDigest(ethers.utils.arrayify(messageHash));
  const expirationBytes = ethers.utils.hexZeroPad(ethers.utils.hexlify(expirationTimestamp), 8);

  Logger.log(
    'Debugging createPaymasterAndData:',
    `userProxyAddress: ${userProxyAddress},expirationTimestamp: ${expirationTimestamp}, chainId: ${actualChainId}, entryPointAddress: ${entryPointAddress}, callData (first 100 chars): ${callData.substring(0, 100)}, encodedData: ${encodedData}, messageHash: ${messageHash}`
  );

  return ethers.utils.hexConcat([
    paymasterAddress,
    ethers.utils.joinSignature(sig),
    expirationBytes
  ]);
}
