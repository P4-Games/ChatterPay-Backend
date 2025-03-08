import { ethers, BigNumber } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { IBlockchain } from '../../models/blockchainModel';
import { getUserOpHash } from '../../helpers/userOperationHelper';
import { PackedUserOperation } from '../../types/userOperationType';

/**
 * Creates a generic user operation for a transaction.
 * Retrieves gas parameters from the blockchain config and applies a multiplier.
 *
 * @param {IBlockchain['gas']} gasConfig - Blockchain gas config with predefined values.
 * @param {string} callData - Encoded function call data.
 * @param {string} sender - Sender address initiating the operation.
 * @param {BigNumber} nonce - Nonce value to prevent replay attacks.
 * @param {'transfer' | 'swap'} userOpType - Operation type determining gas parameters.
 * @param {number} [gasMultiplier=1.0] - Optional multiplier to adjust gas values (default: 1.0).
 * @returns {Promise<PackedUserOperation>} The created user operation with adjusted gas limits and fees.
 */
export async function createGenericUserOperation(
  gasConfig: IBlockchain['gas'],
  callData: string,
  sender: string,
  nonce: BigNumber,
  userOpType: 'transfer' | 'swap',
  gasMultiplier: number = 1.0
): Promise<PackedUserOperation> {
  const gasValues = gasConfig.operations[userOpType];

  Logger.log('createGenericUserOperation', 'Creating Generic UserOperation.');
  Logger.log('createGenericUserOperation', 'Sender Address:', sender);
  Logger.log('createGenericUserOperation', 'Call Data:', callData);
  Logger.log('createGenericUserOperation', 'Nonce:', nonce.toString());
  Logger.log('createGenericUserOperation', 'MAX_FEE_PER_GAS', gasValues.maxFeePerGas);
  Logger.log(
    'createGenericUserOperation',
    'MAX_PRIORITY_FEE_PER_GAS',
    gasValues.maxPriorityFeePerGas
  );
  Logger.log(
    'createGenericUserOperation',
    'VERIFICATION_GAS_LIMIT',
    gasValues.verificationGasLimit
  );
  Logger.log('createGenericUserOperation', 'CALL_GAS_LIMIT', gasValues.callGasLimit);
  Logger.log('createGenericUserOperation', 'PRE_VERIFICATION_GAS', gasValues.preVerificationGas);

  // Calculate adjusted gas values
  const baseMaxFeePerGas = ethers.utils.parseUnits(gasValues.maxFeePerGas, 'gwei');
  const baseMaxPriorityFeePerGas = ethers.utils.parseUnits(gasValues.maxPriorityFeePerGas, 'gwei');

  // Apply multiplier if different from 1.0
  let effectiveMaxFeePerGas = baseMaxFeePerGas;
  let effectiveMaxPriorityFeePerGas = baseMaxPriorityFeePerGas;

  if (gasMultiplier !== 1.0) {
    // Convert multiplier to basis points (e.g., 1.2 → 120)
    const multiplierBasisPoints = Math.floor(gasMultiplier * 100);

    // Apply multiplier to base values
    effectiveMaxFeePerGas = baseMaxFeePerGas.mul(multiplierBasisPoints).div(100);
    effectiveMaxPriorityFeePerGas = baseMaxPriorityFeePerGas.mul(multiplierBasisPoints).div(100);

    Logger.log(
      'createGenericUserOperation',
      `Applying gas multiplier: ${gasMultiplier.toFixed(2)}x`
    );
    Logger.log(
      'createGenericUserOperation',
      `Original MAX_FEE_PER_GAS: ${gasValues.maxFeePerGas} gwei → ${ethers.utils.formatUnits(effectiveMaxFeePerGas, 'gwei')} gwei`
    );
    Logger.log(
      'createGenericUserOperation',
      `Original MAX_PRIORITY_FEE_PER_GAS: ${gasValues.maxPriorityFeePerGas} gwei → ${ethers.utils.formatUnits(effectiveMaxPriorityFeePerGas, 'gwei')} gwei`
    );
  } else {
    Logger.log(
      'createGenericUserOperation',
      `Using standard gas values: MAX_FEE_PER_GAS: ${gasValues.maxFeePerGas} gwei, MAX_PRIORITY_FEE_PER_GAS: ${gasValues.maxPriorityFeePerGas} gwei`
    );
  }

  // Create and return userOp with adjusted gas values
  const userOp: PackedUserOperation = {
    sender,
    nonce,
    initCode: '0x',
    callData,
    verificationGasLimit: BigNumber.from(gasValues.verificationGasLimit),
    callGasLimit: BigNumber.from(gasValues.callGasLimit),
    preVerificationGas: BigNumber.from(gasValues.preVerificationGas),
    maxFeePerGas: effectiveMaxFeePerGas,
    maxPriorityFeePerGas: effectiveMaxPriorityFeePerGas,
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
export async function createTransferCallData(
  chatterPayContract: ethers.Contract,
  erc20Contract: ethers.Contract,
  to: string,
  amount: string
): Promise<string> {
  if (!ethers.utils.isAddress(to)) {
    throw new Error("Invalid 'to' address");
  }

  let amount_bn;
  try {
    const decimals = await erc20Contract.decimals();
    Logger.log('createTransferCallData', 'contract decimals', decimals);
    amount_bn = ethers.utils.parseUnits(amount, decimals);
  } catch (error) {
    Logger.error('createTransferCallData', `amount ${amount} error`, error);
    throw error;
  }

  try {
    Logger.log(
      'createTransferCallData',
      '*** [ executeTokenTransfer ] *** ',
      erc20Contract.address,
      to,
      amount_bn
    );

    const functionSignature = 'executeTokenTransfer(address,address,uint256)';
    const functionSelector = ethers.utils
      .keccak256(ethers.utils.toUtf8Bytes(functionSignature))
      .substring(0, 10);
    const encodedParameters = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint256'],
      [erc20Contract.address, to, amount_bn]
    );
    const callData = functionSelector + encodedParameters.slice(2);
    Logger.log('createTransferCallData', 'Transfer Call Data:', callData);

    return callData;
  } catch (error) {
    Logger.error('createTransferCallData', 'encodeFunctionData error', error);
    throw error;
  }
}

/**
 * Signs the UserOperation by generating a hash of the operation and using the provided signer to sign it.
 * This method ensures the integrity of the user operation and prevents tampering by verifying the signature.
 *
 * @param {PackedUserOperation} userOperation - The user operation to be signed.
 * @param {string} entryPointAddress - The address of the entry point contract.
 * @param {ethers.Wallet} signer - The User wallet used to sign the user operation.
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

  const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);

  const ethSignedMessageHash = ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ['string', 'bytes32'],
      ['\x19Ethereum Signed Message:\n32', userOpHash]
    )
  );

  const { _signingKey } = signer;
  const signature = _signingKey().signDigest(ethers.utils.arrayify(ethSignedMessageHash));
  const recoveredAddress = ethers.utils.recoverAddress(ethSignedMessageHash, signature);

  const { getAddress } = ethers.utils;
  if (getAddress(recoveredAddress) !== getAddress(await signer.getAddress())) {
    throw new Error('Invalid signature');
  }

  return {
    ...userOperation,
    signature: ethers.utils.joinSignature(signature)
  };
}
