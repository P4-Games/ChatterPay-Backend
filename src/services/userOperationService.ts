import { ethers, BigNumber } from 'ethers';

import { Logger } from '../utils/logger';
import { getUserOpHash } from '../utils/userOperation';
import { PackedUserOperationType } from '../types/userOperation';
import {
  CALL_GAS_LIMIT,
  MAX_FEE_PER_GAS,
  PRE_VERIFICATION_GAS,
  VERIFICATION_GAS_LIMIT,
  MAX_PRIORITY_FEE_PER_GAS
} from '../constants/environment';

/**
 * Creates a generic user operation for any type of transaction.
 */
export async function createGenericUserOperation(
  callData: string,
  sender: string,
  nonce: BigNumber
): Promise<PackedUserOperationType> {
  Logger.log('Creating Generic UserOperation.');
  Logger.log('Sender Address:', sender);
  Logger.log('Call Data:', callData);
  Logger.log('Nonce:', nonce.toString());
  Logger.log('PRE_VERIFICATION_GAS', PRE_VERIFICATION_GAS);
  Logger.log('CALL_GAS_LIMIT', CALL_GAS_LIMIT);
  Logger.log('VERIFICATION_GAS_LIMIT', VERIFICATION_GAS_LIMIT);
  Logger.log('MAX_FEE_PER_GAS', MAX_FEE_PER_GAS);
  Logger.log('MAX_PRIORITY_FEE_PER_GAS', MAX_PRIORITY_FEE_PER_GAS);

  // Use high fixed values for gas
  const userOp: PackedUserOperationType = {
    sender,
    nonce,
    initCode: '0x',
    callData,
    verificationGasLimit: BigNumber.from(VERIFICATION_GAS_LIMIT),
    callGasLimit: BigNumber.from(CALL_GAS_LIMIT),
    preVerificationGas: BigNumber.from(PRE_VERIFICATION_GAS),
    maxFeePerGas: BigNumber.from(ethers.utils.parseUnits(MAX_FEE_PER_GAS, 'gwei')),
    maxPriorityFeePerGas: BigNumber.from(ethers.utils.parseUnits(MAX_PRIORITY_FEE_PER_GAS, 'gwei')),
    paymasterAndData: '0x', // Will be filled by the paymaster service
    signature: '0x' // Empty signature initially
  };

  return userOp;
}

/**
 * Creates the encoded call data for a token transfer.
 */
export function createTransferCallData(
  chatterPayContract: ethers.Contract,
  erc20Contract: ethers.Contract,
  to: string,
  amount: string
): string {
  if (!ethers.utils.isAddress(to)) {
    throw new Error("Invalid 'to' address");
  }

  let amount_bn;
  try {
    amount_bn = ethers.utils.parseUnits(amount, 18);
  } catch (error) {
    throw new Error('Invalid amount');
  }

  const transferEncode = erc20Contract.interface.encodeFunctionData('transfer', [to, amount_bn]);
  Logger.log('Transfer Encode:', transferEncode);

  const callData = chatterPayContract.interface.encodeFunctionData('execute', [
    erc20Contract.address,
    0,
    transferEncode
  ]);
  Logger.log('Transfer Call Data:', callData);

  return callData;
}

/**
 * Signs the UserOperation.
 */
export async function signUserOperation(
  userOperation: PackedUserOperationType,
  entryPointAddress: string,
  signer: ethers.Wallet
): Promise<PackedUserOperationType> {
  Logger.log('signUserOperation: Signing UserOperation.');

  const chainId = await signer.getChainId();
  Logger.log('signUserOperation: Chain ID:', chainId);

  Logger.log('signUserOperation: Computing userOpHash.');
  const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);
  Logger.log('signUserOperation: UserOpHash:', userOpHash);

  const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
  Logger.log('signUserOperation: Generated signature:', signature);

  const recoveredAddress = ethers.utils.verifyMessage(ethers.utils.arrayify(userOpHash), signature);
  Logger.log('signUserOperation: Recovered address:', recoveredAddress);
  Logger.log('signUserOperation: Signer address:', await signer.getAddress());

  if (recoveredAddress.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error('signUserOperation: Signature verification failed on client side');
  }

  Logger.log('signUserOperation: UserOperation signed successfully');
  return { ...userOperation, signature };
}
