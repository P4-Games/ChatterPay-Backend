import { ethers, BigNumber } from 'ethers';

import { Logger } from '../utils/logger';
import { getUserOpHash } from '../utils/userOperation';
import { PackedUserOperation } from '../types/userOperation';

/**
 * Creates a generic user operation for any type of transaction.
 */
export async function createGenericUserOperation(
  callData: string,
  sender: string,
  nonce: BigNumber
): Promise<PackedUserOperation> {
  Logger.log('Creating Generic UserOperation.');
  Logger.log('Sender Address:', sender);
  Logger.log('Call Data:', callData);
  Logger.log('Nonce:', nonce.toString());

  // Use high fixed values for gas
  const userOp: PackedUserOperation = {
    sender,
    nonce,
    initCode: '0x',
    callData,
    verificationGasLimit: BigNumber.from(74908),
    callGasLimit: BigNumber.from(79728),
    preVerificationGas: BigNumber.from(94542),
    maxFeePerGas: BigNumber.from(ethers.utils.parseUnits('24', 'gwei')),
    maxPriorityFeePerGas: BigNumber.from(ethers.utils.parseUnits('2', 'gwei')),
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
  userOperation: PackedUserOperation,
  entryPointAddress: string,
  signer: ethers.Wallet
): Promise<PackedUserOperation> {
  Logger.log('\nSigning UserOperation.');

  const chainId = await signer.getChainId();
  Logger.log('Chain ID:', chainId);

  Logger.log('Computing userOpHash.');
  const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);
  Logger.log('UserOpHash:', userOpHash);

  const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
  Logger.log('Generated signature:', signature);

  const recoveredAddress = ethers.utils.verifyMessage(ethers.utils.arrayify(userOpHash), signature);
  Logger.log('Recovered address:', recoveredAddress);
  Logger.log('Signer address:', await signer.getAddress());

  if (recoveredAddress.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
    throw new Error('Signature verification failed on client side');
  }

  Logger.log('UserOperation signed successfully');
  return { ...userOperation, signature };
}
