import { ethers } from 'ethers';

import { PackedUserOperation } from '../types/userOperationType';

/**
 * Packs the UserOperation fields as per the contract's pack function.
 *
 * This function takes the `userOp` object and converts its fields into an ABI-encoded format that
 * mimics how they would be packed in the contract's `pack` function.
 *
 * @param userOp - The UserOperation object containing fields to be packed.
 * @returns The ABI-encoded packed user operation as a hex string.
 */
function packUserOp(userOp: PackedUserOperation): string {
  const { sender } = userOp;
  const { nonce } = userOp;
  const hashInitCode = ethers.utils.keccak256(userOp.initCode);
  const hashCallData = ethers.utils.keccak256(userOp.callData);
  const { callGasLimit } = userOp;
  const { verificationGasLimit } = userOp;
  const { preVerificationGas } = userOp;
  const { maxFeePerGas } = userOp;
  const { maxPriorityFeePerGas } = userOp;
  const hashPaymasterAndData = ethers.utils.keccak256(userOp.paymasterAndData);

  const types = [
    'address', // sender
    'uint256', // nonce
    'bytes32', // hashInitCode
    'bytes32', // hashCallData
    'uint256', // callGasLimit
    'uint256', // verificationGasLimit
    'uint256', // preVerificationGas
    'uint256', // maxFeePerGas
    'uint256', // maxPriorityFeePerGas
    'bytes32' // hashPaymasterAndData
  ];

  const values = [
    sender,
    nonce,
    hashInitCode,
    hashCallData,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    hashPaymasterAndData
  ];

  // ABI-encode the packed user operation
  const encoded = ethers.utils.defaultAbiCoder.encode(types, values);
  return encoded;
}

/**
 * Computes the hash of the UserOperation, replicating the contract's hash function.
 *
 * This function takes the packed user operation and applies the keccak256 hash function to it
 * to compute the hash, replicating the contract's `getUserOpHash` function.
 *
 * @param userOp - The UserOperation object containing the fields to be hashed.
 * @returns The hash of the packed user operation as a hex string.
 */
function hashUserOp(userOp: PackedUserOperation): string {
  const packedUserOp = packUserOp(userOp);
  return ethers.utils.keccak256(packedUserOp);
}

/**
 * Computes the userOpHash for signing, replicating the contract's getUserOpHash function.
 *
 * This function combines the user operation hash, the EntryPoint contract address, and the chain ID
 * into a final hash that can be used for signing by the user. This mimics the functionality of the
 * `getUserOpHash` function in the contract.
 *
 * @param userOp - The UserOperation object containing the fields to be used in the final hash.
 * @param entryPointAddress - The address of the EntryPoint contract used in the user operation.
 * @param chainId - The chain ID of the network where the operation will take place.
 * @returns The userOpHash as a hex string, which is used for signing.
 */
export function getUserOpHash(
  userOp: PackedUserOperation,
  entryPointAddress: string,
  chainId: number
): string {
  const userOpHash = hashUserOp(userOp);

  // ABI encode [userOpHash, entryPointAddress, chainId]
  const encoded = ethers.utils.defaultAbiCoder.encode(
    ['bytes32', 'address', 'uint256'],
    [userOpHash, entryPointAddress, chainId]
  );

  // Compute the keccak256 hash
  const finalUserOpHash = ethers.utils.keccak256(encoded);
  return finalUserOpHash;
}
