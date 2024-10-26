import { BigNumber } from 'ethers';

/**
 * Represents a packed user operation for Ethereum transactions.
 */
export interface PackedUserOperation {
    /** The address of the sender */
    sender: string;
    /** The nonce of the operation */
    nonce: BigNumber;
    /** The initialization code for the operation */
    initCode: string;
    /** The call data for the operation */
    callData: string;
    /** The gas limit for the call */
    callGasLimit: BigNumber;
    /** The gas limit for verification */
    verificationGasLimit: BigNumber;
    /** The gas used before the main execution */
    preVerificationGas: BigNumber;
    /** The maximum fee per gas unit the user is willing to pay */
    maxFeePerGas: BigNumber;
    /** The maximum priority fee per gas unit */
    maxPriorityFeePerGas: BigNumber;
    /** The paymaster data, if any */
    paymasterAndData: string;
    /** The signature of the operation */
    signature: string;
}