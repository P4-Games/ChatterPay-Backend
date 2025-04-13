import { ethers, Contract, BigNumber } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
import { OpGasValues } from '../../models/blockchainModel';
import { getUserOpHash } from '../../helpers/userOperationHelper';
import { PackedUserOperation } from '../../types/userOperationType';

/**
 * Generates a dummy signature for a given UserOperation.
 *
 * This function creates a dummy version of the UserOperation, computes its hash,
 * and then signs it using a random private key to generate a dummy signature.
 *
 * @param userOperation - The user operation for which a dummy signature will be generated.
 * @param entryPointAddress - The entry point address for the operation.
 * @param chainId - The chain ID for the operation.
 * @returns The generated dummy signature.
 */
export async function generateDummySignature(
  userOperation: Partial<PackedUserOperation>,
  entryPointAddress: string,
  chainId: number
): Promise<string> {
  // Create a "dummy" version of the UserOperation
  const dummyUserOp: PackedUserOperation = {
    sender: userOperation.sender ?? ethers.constants.AddressZero,
    nonce: userOperation.nonce || ethers.constants.Zero,
    initCode: userOperation.initCode ?? '0x',
    callData: userOperation.callData ?? '0x',
    callGasLimit: userOperation.callGasLimit || ethers.constants.Zero,
    verificationGasLimit: userOperation.verificationGasLimit || ethers.constants.Zero,
    preVerificationGas: userOperation.preVerificationGas || ethers.constants.Zero,
    maxFeePerGas: userOperation.maxFeePerGas || ethers.constants.Zero,
    maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas || ethers.constants.Zero,
    paymasterAndData: userOperation.paymasterAndData ?? '0x',
    signature: '0x'
  };

  // Compute the hash of the dummy operation
  const userOpHash = getUserOpHash(dummyUserOp, entryPointAddress, chainId);

  // Generate a dummy signature
  // We use a random private key for this
  const dummyWallet = ethers.Wallet.createRandom();
  const dummySignature = await dummyWallet.signMessage(ethers.utils.arrayify(userOpHash));

  Logger.log('generateDummySignature', dummySignature);

  return dummySignature;
}

/**
 * Calculates recommended gas values, prioritizing latest network estimations.
 * Applies a custom multiplier (percentage increase) to the recommended gas values.
 * Falls back to provided defaults if estimation fails or results are zero.
 *
 * @param defaultPerGasValues - Default gas values (as strings in Gwei)
 * @param provider - Ethereum JSON RPC provider
 * @param gasMultiplier - Multiplier for recommended gas values (e.g., 1.2 for 20% increase)
 * @returns Recommended maxPriorityFeePerGas and maxFeePerGas as BigNumbers
 */
const getPerGasValues = async (
  defaultPerGasValues: { maxFeePerGas: string; maxPriorityFeePerGas: string },
  provider: ethers.providers.JsonRpcProvider,
  gasMultiplier: number
): Promise<{ maxPriorityFeePerGas: BigNumber; maxFeePerGas: BigNumber }> => {
  const DEFAULT_MAX_FEE = ethers.utils.parseUnits(defaultPerGasValues.maxFeePerGas, 'gwei');
  const DEFAULT_PRIORITY_FEE = ethers.utils.parseUnits(
    defaultPerGasValues.maxPriorityFeePerGas,
    'gwei'
  );

  try {
    const feeHistory = await provider.send('eth_feeHistory', ['0x5', 'latest', [25, 50, 75]]);
    const baseFees = feeHistory.baseFeePerGas.map((fee: string) => BigNumber.from(fee));
    const priorityFees = feeHistory.reward.flat().map((fee: string) => BigNumber.from(fee));

    if (priorityFees.length === 0 || baseFees.length < 2) {
      throw new Error('Invalid fee history data');
    }

    const latestBaseFee = baseFees[baseFees.length - 2];
    const avgPriorityFee = priorityFees
      .reduce((a: BigNumber, b: BigNumber) => a.add(b), BigNumber.from(0))
      .div(priorityFees.length);

    let adjustedMaxFee = latestBaseFee
      .add(avgPriorityFee)
      .mul(Math.round(gasMultiplier * 100))
      .div(100);

    let adjustedPriorityFee = avgPriorityFee.mul(Math.round(gasMultiplier * 100)).div(100);

    if (adjustedMaxFee.lte(0)) {
      adjustedMaxFee = ethers.utils.parseUnits(defaultPerGasValues.maxFeePerGas, 'gwei');
    }

    if (adjustedPriorityFee.lte(0)) {
      adjustedPriorityFee = ethers.utils.parseUnits(
        defaultPerGasValues.maxPriorityFeePerGas,
        'gwei'
      );
    }

    Logger.info(
      'getPerGasValues',
      `Base Fee: ${ethers.utils.formatUnits(latestBaseFee, 'gwei')} gwei, ` +
        `Priority Fee: ${ethers.utils.formatUnits(adjustedPriorityFee, 'gwei')} gwei, ` +
        `Max Fee: ${ethers.utils.formatUnits(adjustedMaxFee, 'gwei')} gwei`
    );

    return {
      maxPriorityFeePerGas: adjustedPriorityFee,
      maxFeePerGas: adjustedMaxFee
    };
  } catch (error) {
    Logger.error('getRecommendedGasFees', error);
    return {
      maxPriorityFeePerGas: DEFAULT_PRIORITY_FEE,
      maxFeePerGas: DEFAULT_MAX_FEE
    };
  }
};

/**
 * Estimates gas values required for a user operation.
 *
 * @param userOperation - The packed user operation containing transaction details.
 * @param rpcUrl - The RPC URL to send the request for gas estimation.
 * @param entryPointContractAddress - The address of the EntryPoint contract.
 * @param gasMultiplier - A multiplier to adjust the estimated gas limits (default is 1).
 *
 * @returns An object containing estimated gas limits:
 *          - callGasLimit: The gas required for executing the call.
 *          - verificationGasLimit: The gas required for verification.
 *          - preVerificationGas: The gas required before verification.
 */
const getcallDataGasValues = async (
  opGasValues: OpGasValues,
  userOperation: PackedUserOperation,
  rpcUrl: string,
  entryPointContractAddress: string,
  gasMultiplier: number = 1
): Promise<{
  callGasLimit: BigNumber;
  verificationGasLimit: BigNumber;
  preVerificationGas: BigNumber;
}> => {
  const gasResult = {
    callGasLimit: BigNumber.from(opGasValues.callGasLimit),
    verificationGasLimit: BigNumber.from(opGasValues.verificationGasLimit),
    preVerificationGas: BigNumber.from(opGasValues.preVerificationGas)
  };

  const AlchemyUserOp = {
    sender: userOperation.sender,
    nonce: userOperation.nonce.toHexString(),
    initCode: userOperation.initCode,
    callData: userOperation.callData,
    maxFeePerGas: userOperation.maxFeePerGas.toHexString(),
    maxPriorityFeePerGas: userOperation.maxPriorityFeePerGas.toHexString(),
    paymasterAndData: userOperation.paymasterAndData,
    signature: userOperation.signature
  };

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_estimateUserOperationGas',
      params: [AlchemyUserOp, entryPointContractAddress]
    })
  });

  let gettingGasValuesfrom = 'bdd';
  const alchemyResult = await response.json();

  if (alchemyResult && alchemyResult.result) {
    gasResult.callGasLimit = BigNumber.from(alchemyResult.result.callGasLimit)
      .mul(Math.round(gasMultiplier * 100))
      .div(100);
    gasResult.verificationGasLimit = BigNumber.from(alchemyResult.result.verificationGasLimit);
    gasResult.preVerificationGas = BigNumber.from(alchemyResult.result.preVerificationGas);
    gettingGasValuesfrom = 'alchemy';
  }

  Logger.log('getcallDataGasValues', '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
  Logger.info(
    'getcallDataGasValues',
    `Gas Params - callGasLimit: ${userOperation.callGasLimit.toString()}, verificationGasLimit: ${userOperation.verificationGasLimit.toString()}, preVerificationGas: ${userOperation.preVerificationGas.toString()}, maxFeePerGas: ${userOperation.maxFeePerGas.toString()} , maxPriorityFeePerGas: ${userOperation.maxPriorityFeePerGas.toString()}, getted values from: ${gettingGasValuesfrom}`
  );
  Logger.log('getcallDataGasValues', '~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');

  return {
    callGasLimit: gasResult.callGasLimit,
    verificationGasLimit: gasResult.verificationGasLimit,
    preVerificationGas: gasResult.preVerificationGas
  };
};

/**
 * Calculates a dynamic gas limit for a contract method, including a buffer percentage.
 * If estimation fails, it falls back to a default gas limit.
 *
 * @param {Contract} contract - The contract instance where the method will be executed.
 * @param {string} methodName - The name of the contract method to estimate gas for.
 * @param {unknown[]} args - The arguments to pass to the contract method.
 * @param {number} [gasBufferPercentage=10] - The buffer percentage to add to the estimated gas.
 * @param {BigNumber} [defaultGasLimit=BigNumber.from('7000000')] - The fallback gas limit if estimation fails.
 * @returns {Promise<BigNumber>} - The calculated gas limit.
 */
const getDynamicGas = async (
  contract: Contract,
  methodName: string,
  args: unknown[],
  gasBufferPercentage: number = 20,
  defaultGasLimit: BigNumber = BigNumber.from('250000')
): Promise<BigNumber> => {
  const defaultGasMessage = `Default Estimated gas limit for ${methodName}: ${defaultGasLimit.toString()}`;

  try {
    if (typeof contract[methodName] !== 'function') {
      throw new Error(`The method ${methodName} doesn't exist in contract.`);
    }

    try {
      await contract.callStatic[methodName](...args);
    } catch (staticError) {
      Logger.warn('getDynamicGas', `Static call failed for ${methodName}:`, staticError);
      Logger.log('getDynamicGas', defaultGasMessage);
      return defaultGasLimit;
    }

    const estimatedGas: ethers.BigNumber = await contract.estimateGas[methodName](...args);
    const gasLimit: BigNumber = estimatedGas
      .mul(BigNumber.from(100 + gasBufferPercentage))
      .div(BigNumber.from(100));
    Logger.log('getDynamicGas', `Estimated gas limit for ${methodName}:`, gasLimit.toString());

    return gasLimit;
  } catch (error) {
    Logger.warn('getDynamicGas', `Gas estimation failed for ${methodName}:`, error);
    Logger.log('getDynamicGas', defaultGasMessage);
    return defaultGasLimit;
  }
};

export const gasService = {
  getPerGasValues,
  getcallDataGasValues,
  getDynamicGas
};
