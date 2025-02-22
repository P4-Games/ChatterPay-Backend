import { BigNumber } from 'ethers';

/**
 * Represents a packed user operation for Ethereum transactions.
 *
 * sender: The account making the operation.
 * nonce: Anti-replay parameter (see �Semi-abstracted Nonce Support�).
 * initCode: The initCode of the account, needed only if the account is not
 * yet on-chain and needs to be created.
 * callData: The data to pass to the sender during the main execution call.
 * callGasLimit: The amount of gas allocated for the main execution call.
 * verificationGasLimit: The amount of gas allocated for the verification step.
 * preVerificationGas: The gas paid to compensate the bundler for
 * pre-verification execution and calldata.
 * maxFeePerGas: Maximum fee per gas (similar to EIP-1559 max_fee_per_gas).
 * maxPriorityFeePerGas: Maximum priority fee per gas (similar to
 * EIP-1559 max_priority_fee_per_gas).
 * paymasterAndData: Address of paymaster sponsoring the transaction, followed
 * by extra data sent to the paymaster (empty for self-sponsored transactions).
 * signature: Data passed into the account along with the nonce during the
 * verification step.
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
