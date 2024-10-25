import { ethers } from 'ethers';

import { PackedUserOperation } from '../types/userOperation';

/**
 * Packs the UserOperation fields as per the contract's pack function.
 * 
 * @param userOp - The UserOperation object.
 * @returns The ABI-encoded packed user operation as a hex string.
 */
function packUserOp(userOp: PackedUserOperation): string {
    const {sender} = userOp;
    const {nonce} = userOp;
    const hashInitCode = ethers.utils.keccak256(userOp.initCode);
    const hashCallData = ethers.utils.keccak256(userOp.callData);
    const {callGasLimit} = userOp;
    const {verificationGasLimit} = userOp;
    const {preVerificationGas} = userOp;
    const {maxFeePerGas} = userOp;
    const {maxPriorityFeePerGas} = userOp;
    const hashPaymasterAndData = ethers.utils.keccak256(userOp.paymasterAndData);

    const types = [
        "address",      // sender
        "uint256",      // nonce
        "bytes32",      // hashInitCode
        "bytes32",      // hashCallData
        "uint256",      // callGasLimit
        "uint256",      // verificationGasLimit
        "uint256",      // preVerificationGas
        "uint256",      // maxFeePerGas
        "uint256",      // maxPriorityFeePerGas
        "bytes32"       // hashPaymasterAndData
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
 * @param userOp - The UserOperation object.
 * @returns The hash of the packed user operation as a hex string.
 */
export function hashUserOp(userOp: PackedUserOperation): string {
    const packedUserOp = packUserOp(userOp);
    return ethers.utils.keccak256(packedUserOp);
}

/**
 * Computes the userOpHash for signing, replicating the contract's getUserOpHash function.
 * 
 * @param userOp - The UserOperation object.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @param chainId - The chain ID of the network.
 * @returns The userOpHash as a hex string.
 */
export function getUserOpHash(userOp: PackedUserOperation, entryPointAddress: string, chainId: number): string {
    const userOpHash = hashUserOp(userOp);

    // ABI encode [userOpHash, entryPointAddress, chainId]
    const encoded = ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "address", "uint256"],
        [userOpHash, entryPointAddress, chainId]
    );

    // Compute the keccak256 hash
    const finalUserOpHash = ethers.utils.keccak256(encoded);
    return finalUserOpHash;
}

export function serializeUserOperation(userOp: PackedUserOperation): Record<string, string> {
    return {
        sender: userOp.sender,
        nonce: ethers.utils.hexlify(userOp.nonce),
        initCode: userOp.initCode,
        callData: userOp.callData,
        callGasLimit: ethers.utils.hexlify(userOp.callGasLimit),
        verificationGasLimit: ethers.utils.hexlify(userOp.verificationGasLimit),
        preVerificationGas: ethers.utils.hexlify(userOp.preVerificationGas),
        maxFeePerGas: ethers.utils.hexlify(userOp.maxFeePerGas),
        maxPriorityFeePerGas: ethers.utils.hexlify(userOp.maxPriorityFeePerGas),
        paymasterAndData: userOp.paymasterAndData,
        signature: userOp.signature,
    };
}