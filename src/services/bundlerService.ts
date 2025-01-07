import PQueue from 'p-queue';
import { ethers } from 'ethers';
import axios, { AxiosResponse } from 'axios';

import { Logger } from '../utils/logger';
import { PackedUserOperationType } from '../types/userOperation';

const queue = new PQueue({ interval: 10000, intervalCap: 1 }); // 1 request each 10 seg

/**
 * Sends a user operation to the bundler.
 *
 * @param bundlerUrl - The URL of the bundler.
 * @param userOperation - The packed user operation to send.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @returns The bundler's response.
 * @throws Error if the request fails.
 */
export async function sendUserOperationToBundler(
  bundlerUrl: string,
  userOperation: PackedUserOperationType,
  entryPointAddress: string
): Promise<string> {
  try {
    const serializedUserOp = serializeUserOperation(userOperation);
    Logger.log('Serialized UserOperation:', JSON.stringify(serializedUserOp));
    const payload = {
      jsonrpc: '2.0',
      method: 'eth_sendUserOperation',
      params: [serializedUserOp, entryPointAddress],
      id: Date.now()
    };

    // Wrapper function in quue to avoid erro 429 (rate-limit)
    const response = (await queue.add(async () =>
      axios.post(bundlerUrl, payload, {
        headers: {
          'Content-Type': 'application/json'
        }
      })
    )) as AxiosResponse;

    if (response.data.error) {
      Logger.error('Bundler returned an error:', response.data.error);
      // Logger.error('Bundler returned an error:', response.data.error);
      if (response.data.error.data) {
        Logger.error('Bundler error data:', response.data.error.data);
      }
      throw new Error(`Bundler Error: ${response.data.error.message}`);
    }

    if (!response.data.result) {
      throw new Error('Bundler did not return a result');
    }

    return response.data.result as string;
  } catch (error: unknown) {
    Logger.error(
      'Error sending user operation to bundler:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    throw error;
  }
}

/**
 * Estimates the gas that will be used in the UserOperation
 *
 * @param bundlerUrl
 * @param userOperation
 * @param entryPointAddress
 */
export async function estimateUserOperationGas(
  bundlerUrl: string,
  userOperation: PackedUserOperationType,
  entryPointAddress: string
): Promise<void> {
  try {
    const serializedUserOp = serializeUserOperation(userOperation);
    const payload = {
      jsonrpc: '2.0',
      method: 'eth_estimateUserOperationGas',
      params: [serializedUserOp, entryPointAddress],
      id: Date.now()
    };

    // Wrapper function in quue to avoid erro 429 (rate-limit)
    const response = (await queue.add(async () =>
      axios.post(bundlerUrl, payload, {
        headers: {
          accept: 'application/json',
          'Content-Type': 'application/json'
        }
      })
    )) as AxiosResponse;

    if (response.data.error) {
      Logger.error('Gas estimation error:', response.data.error);
      throw new Error(`Gas estimation failed: ${response.data.error.message}`);
    }

    Logger.log('Gas Estimation:', response.data.result);
  } catch (error) {
    Logger.error('Error estimating gas:', error);
    throw error;
  }
}

/**
 * Serialize User Operation
 * @param userOp
 * @returns
 */
function serializeUserOperation(userOp: PackedUserOperationType): Record<string, string> {
  return {
    sender: userOp.sender,
    nonce: ethers.utils.hexlify(userOp.nonce),
    initCode: userOp.initCode,
    callData: userOp.callData,
    callGasLimit: ethers.utils.hexlify(userOp.callGasLimit),
    verificationGasLimit: ethers.utils.hexlify(userOp.verificationGasLimit),
    preVerificationGas: ethers.utils.hexlify(userOp.preVerificationGas),
    maxFeePerGas: ethers.utils.hexlify(userOp.maxFeePerGas),
    maxPriorityFeePerGas: ethers.utils.hexlify(userOp.maxPriorityFeePerGas),
    paymasterAndData: userOp.paymasterAndData,
    signature: userOp.signature
  };
}
