import PQueue from 'p-queue';
import { ethers, BigNumber } from 'ethers';
import axios, { AxiosResponse } from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { QUEUE_GAS_INTERVAL } from '../../config/constants';
import { getUserOpHash } from '../../helpers/userOperationHelper';
import { PackedUserOperation } from '../../types/userOperationType';
import { IBlockchain, OpGasValues } from '../../models/blockchainModel';

interface AlchemyGasResponse {
  paymasterAndData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

interface GasOverrides {
  maxFeePerGas?: string | { multiplier: number };
  maxPriorityFeePerGas?: string | { multiplier: number };
  callGasLimit?: string | { multiplier: number };
  verificationGasLimit?: string | { multiplier: number };
  preVerificationGas?: string | { multiplier: number };
}

interface GasServiceConfig {
  apiKey: string;
  policyId: string;
  entryPoint: string;
  network: string;
}

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
// 1 request every 10 seconds
const queue = new PQueue({ interval: QUEUE_GAS_INTERVAL, intervalCap: 1 });

/**
 * Retrieves the paymaster data for a UserOperation from the gas service.
 *
 * This function requests the paymaster data, including the gas limits and other parameters,
 * by interacting with an external gas service API.
 *
 * @param config - Configuration for the gas service.
 * @param userOp - The user operation for which paymaster data is required.
 * @param signer - The signer for the operation.
 * @param overrides - Optional gas overrides for customization.
 * @returns The gas service response containing paymaster data and gas limits.
 */
export async function getPaymasterAndData(
  networkConfig: IBlockchain,
  config: GasServiceConfig,
  userOp: Partial<PackedUserOperation>,
  signer: ethers.Signer,
  overrides?: GasOverrides
): Promise<AlchemyGasResponse> {
  const chainId = await signer.getChainId();
  const dummySignature = await generateDummySignature(userOp, config.entryPoint, chainId);

  const payload = {
    id: `ChatterPay.${Date.now().toLocaleString()}`,
    jsonrpc: '2.0',
    method: 'alchemy_requestGasAndPaymasterAndData',
    params: [
      {
        policyId: config.policyId,
        entryPoint: config.entryPoint,
        dummySignature,
        userOperation: {
          sender: userOp.sender,
          nonce: userOp.nonce ? ethers.utils.hexlify(userOp.nonce) : '0x0',
          initCode: userOp.initCode ?? '0x',
          callData: userOp.callData
        },
        overrides
      }
    ]
  };

  try {
    // Wrapper function in queue to avoid error 429 (rate-limit)
    const response = (await queue.add(async () =>
      axios.post(networkConfig.bundlerUrl!, payload, {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        }
      })
    )) as AxiosResponse;

    if (response.data.error) {
      throw new Error(`Alchemy API Error: ${response.data.error.message}`);
    }

    return response.data.result;
  } catch (error) {
    Logger.error('getPaymasterAndData', error);
    throw error;
  }
}

/**
 * Applies the paymaster data to a UserOperation.
 *
 * This function retrieves the required paymaster data and updates the UserOperation with it,
 * including the gas limits and other parameters provided by the gas service.
 *
 * @param config - Configuration for the gas service.
 * @param userOp - The user operation to update.
 * @param signer - The signer for the operation.
 * @param overrides - Optional gas overrides for customization.
 * @returns A new UserOperation with the paymaster data applied.
 */
const applyPaymasterDataToUserOp = async (
  networkConfig: IBlockchain,
  config: GasServiceConfig,
  userOp: Partial<PackedUserOperation>,
  signer: ethers.Signer,
  overrides?: GasOverrides
): Promise<PackedUserOperation> => {
  const gasData = await getPaymasterAndData(networkConfig, config, userOp, signer, overrides);

  return {
    ...userOp,
    paymasterAndData: gasData.paymasterAndData,
    callGasLimit: BigNumber.from(gasData.callGasLimit),
    verificationGasLimit: BigNumber.from(gasData.verificationGasLimit),
    preVerificationGas: BigNumber.from(gasData.preVerificationGas),
    maxFeePerGas: BigNumber.from(gasData.maxFeePerGas),
    maxPriorityFeePerGas: BigNumber.from(gasData.maxPriorityFeePerGas)
  } as PackedUserOperation;
};

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

    Logger.log(
      'getRecommendedGasFees',
      `Base Fee: ${latestBaseFee.toString()} (${ethers.utils.formatUnits(
        latestBaseFee,
        'gwei'
      )} gwei), Priority Fee: ${adjustedPriorityFee.toString()} (${ethers.utils.formatUnits(
        adjustedPriorityFee,
        'gwei'
      )} gwei), Max Fee: ${adjustedMaxFee.toString()} (${ethers.utils.formatUnits(
        adjustedMaxFee,
        'gwei'
      )} gwei)`
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
  Logger.log(
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

export const gasService = {
  getPaymasterAndData,
  applyPaymasterDataToUserOp,
  getPerGasValues,
  getcallDataGasValues
};
