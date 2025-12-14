import type { BigNumber } from 'ethers';

/**
 * Represents a packed user operation for Ethereum execution.
 *
 * sender: The account initiating the operation.
 * nonce: Anti-replay parameter (see Semi-abstracted Nonce Support).
 * initCode: Initialization code for the account, required only if the account
 * is not yet deployed on-chain.
 * callData: Encoded data passed to the account during execution.
 * callGasLimit: Gas allocated for the main execution call.
 * verificationGasLimit: Gas allocated for the verification process.
 * preVerificationGas: Gas paid to compensate the bundler for
 * pre-verification steps and calldata.
 * maxFeePerGas: Maximum gas fee (aligned with EIP-1559 max_fee_per_gas).
 * maxPriorityFeePerGas: Maximum priority gas fee (aligned with
 * EIP-1559 max_priority_fee_per_gas).
 * paymasterAndData: Paymaster address sponsoring the operation, followed by
 * optional additional data (empty for self-sponsored operations).
 * authData: Extra authorization data included with the operation.
 */
export interface PackedUserOperation {
  sender: string;
  nonce: BigNumber;
  initCode: string;
  callData: string;
  callGasLimit: BigNumber;
  verificationGasLimit: BigNumber;
  preVerificationGas: BigNumber;
  maxFeePerGas: BigNumber;
  maxPriorityFeePerGas: BigNumber;
  paymasterAndData: string;
  signature: string;
}

export interface UserOperationReceiptData {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  contractAddress: string | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
  logsBloom: string;
  status: string;
}

export interface UserOperationReceipt {
  userOpHash: string;
  entryPoint: string;
  sender: string;
  nonce: string;
  paymaster: string;
  actualGasCost: string;
  actualGasUsed: string;
  success: boolean;
  reason: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
  receipt: UserOperationReceiptData;
}
