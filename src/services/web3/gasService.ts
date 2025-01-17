import PQueue from 'p-queue';
import { ethers, BigNumber } from 'ethers';
import axios, { AxiosResponse } from 'axios';

import { Logger } from '../../helpers/loggerHelper';
import { IBlockchain } from '../../models/blockchainModel';
import { QUEUE_GAS_INTERVAL } from '../../config/constants';
import { getUserOpHash } from '../../helpers/userOperationHekper';
import { PackedUserOperationType } from '../../types/userOperationType';

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

const createGasServiceConfig = (
  apiKey: string,
  policyId: string,
  entryPoint: string,
  network: string = 'arb-sepolia'
): GasServiceConfig => ({
  apiKey,
  policyId,
  entryPoint,
  network
});

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
  userOperation: Partial<PackedUserOperationType>,
  entryPointAddress: string,
  chainId: number
): Promise<string> {
  // Create a "dummy" version of the UserOperation
  const dummyUserOp: PackedUserOperationType = {
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
  userOp: Partial<PackedUserOperationType>,
  signer: ethers.Signer,
  overrides?: GasOverrides
): Promise<AlchemyGasResponse> {
  const chainId = await signer.getChainId();
  const dummySignature = await generateDummySignature(userOp, config.entryPoint, chainId);

  const payload = {
    id: 1,
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
      axios.post(networkConfig.bundlerUrl, payload, {
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
  userOp: Partial<PackedUserOperationType>,
  signer: ethers.Signer,
  overrides?: GasOverrides
): Promise<PackedUserOperationType> => {
  const gasData = await getPaymasterAndData(networkConfig, config, userOp, signer, overrides);

  return {
    ...userOp,
    paymasterAndData: gasData.paymasterAndData,
    callGasLimit: BigNumber.from(gasData.callGasLimit),
    verificationGasLimit: BigNumber.from(gasData.verificationGasLimit),
    preVerificationGas: BigNumber.from(gasData.preVerificationGas),
    maxFeePerGas: BigNumber.from(gasData.maxFeePerGas),
    maxPriorityFeePerGas: BigNumber.from(gasData.maxPriorityFeePerGas)
  } as PackedUserOperationType;
};

export const gasService = {
  createConfig: createGasServiceConfig,
  getPaymasterAndData,
  applyPaymasterDataToUserOp
};
