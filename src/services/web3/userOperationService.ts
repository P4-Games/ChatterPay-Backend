import { ethers, BigNumber } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { getUserOpHash } from '../../helpers/userOperationHekper';
import { PackedUserOperation } from '../../types/userOperationType';
import {
  CALL_GAS_LIMIT,
  MAX_FEE_PER_GAS,
  PRE_VERIFICATION_GAS,
  VERIFICATION_GAS_LIMIT,
  MAX_PRIORITY_FEE_PER_GAS
} from '../../config/constants';

/**
 * Creates a generic user operation for any type of transaction.
 * This method uses a high fixed value for various gas-related parameters and returns the packed user operation.
 *
 * @param {string} callData - The encoded data for the function call.
 * @param {string} sender - The sender address initiating the user operation.
 * @param {BigNumber} nonce - The nonce value to prevent replay attacks.
 * @returns {Promise<PackedUserOperation>} The created user operation with predefined gas limits and fee parameters.
 */
export async function createGenericUserOperation(
  callData: string,
  sender: string,
  nonce: BigNumber
): Promise<PackedUserOperation> {
  Logger.log('createGenericUserOperation', 'Creating Generic UserOperation.');
  Logger.log('createGenericUserOperation', 'Sender Address:', sender);
  Logger.log('createGenericUserOperation', 'Call Data:', callData);
  Logger.log('createGenericUserOperation', 'Nonce:', nonce.toString());
  Logger.log('createGenericUserOperation', 'PRE_VERIFICATION_GAS', PRE_VERIFICATION_GAS);
  Logger.log('createGenericUserOperation', 'CALL_GAS_LIMIT', CALL_GAS_LIMIT);
  Logger.log('createGenericUserOperation', 'VERIFICATION_GAS_LIMIT', VERIFICATION_GAS_LIMIT);
  Logger.log('createGenericUserOperation', 'MAX_FEE_PER_GAS', MAX_FEE_PER_GAS);
  Logger.log('createGenericUserOperation', 'MAX_PRIORITY_FEE_PER_GAS', MAX_PRIORITY_FEE_PER_GAS);

  // Use high fixed values for gas
  const userOp: PackedUserOperation = {
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
 * This method is designed to encode the parameters required for a token transfer
 * and returns the encoded data to be included in the user operation.
 *
 * @param {ethers.Contract} chatterPayContract - The contract for the ChatterPay service.
 * @param {ethers.Contract} erc20Contract - The ERC20 token contract to interact with.
 * @param {string} to - The address of the recipient for the token transfer.
 * @param {string} amount - The amount of tokens to be transferred.
 * @returns {string} The encoded call data for the token transfer.
 * @throws {Error} If the 'to' address is invalid or the amount cannot be parsed.
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

  const callData = chatterPayContract.interface.encodeFunctionData('executeTokenTransfer', [
    erc20Contract.address,
    to,
    amount_bn
  ]);
  
  /*
    The following code is an example of how to encode a different function call.
    It must work if validated by the paymaster.

    const callData = chatterPayContract.interface.encodeFunctionData('setTokenWhitelistAndPriceFeed', [
      "0xe6B817E31421929403040c3e42A6a5C5D2958b4A",
      true,
      "0x80EDee6f667eCc9f63a0a6f55578F870651f06A4"
    ]);
  */

  Logger.log('createTransferCallData', 'Transfer Call Data:', callData);

  return callData;
}

/**
 * Signs the UserOperation by generating a hash of the operation and using the provided signer to sign it.
 * This method ensures the integrity of the user operation and prevents tampering by verifying the signature.
 *
 * @param {PackedUserOperation} userOperation - The user operation to be signed.
 * @param {string} entryPointAddress - The address of the entry point contract.
 * @param {ethers.Wallet} signer - The wallet used to sign the user operation.
 * @returns {Promise<PackedUserOperation>} The user operation with the generated signature.
 * @throws {Error} If the signature verification fails.
 */

export async function signUserOperation(
  userOperation: PackedUserOperation,
  entryPointAddress: string,
  signer: ethers.Wallet
): Promise<PackedUserOperation> {
  const { provider } = signer;
  const { chainId } = await provider!.getNetwork();

  // 1. Generate userOpHash (correct format for EntryPoint)
  const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);

  // 2. Sign the hash WITHOUT Ethereum prefix
  const { _signingKey } = signer;
  
  const signature = _signingKey().signDigest(
    ethers.utils.arrayify(userOpHash)
  );

  // 3. Verify using EntryPoint's method (without prefix)
  const recoveredAddress = ethers.utils.recoverAddress(
    userOpHash, // Original hash, no prefix
    signature
  );

  const { getAddress } = ethers.utils;
  if (getAddress(recoveredAddress) !== getAddress(await signer.getAddress())) {
    throw new Error('Invalid signature');
  }

  return { 
    ...userOperation,
    signature: ethers.utils.joinSignature(signature) 
  };
}