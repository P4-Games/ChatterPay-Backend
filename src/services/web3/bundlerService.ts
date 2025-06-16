import { ethers } from 'ethers';
import axios, { AxiosResponse } from 'axios';

import { wrapRpc } from './rpc/rpcService';
import { Logger } from '../../helpers/loggerHelper';
import { rpcProviders } from '../../types/commonType';
import { PackedUserOperation } from '../../types/userOperationType';

/**
 * Serialize User Operation
 * @param userOp
 * @returns
 */
function serializeUserOperation(userOp: PackedUserOperation): Record<string, string> {
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

/**
 * Sends a user operation to the bundler.
 *
 * @param bundlerRpcUrl - The URL of the rpc.
 * @param userOperation - The packed user operation to send.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @returns The bundler's response.
 * @throws Error if the request fails.
 */
export async function sendUserOperationToBundler(
  bundlerRpcUrl: string,
  userOperation: PackedUserOperation,
  entryPointAddress: string
): Promise<string> {
  try {
    const serializedUserOp = serializeUserOperation(userOperation);
    const payload = {
      jsonrpc: '2.0',
      method: 'eth_sendUserOperation',
      params: [serializedUserOp, entryPointAddress],
      id: Date.now()
    };
    Logger.log(
      'sendUserOperationToBundler',
      `payload: ${JSON.stringify(payload)}, bundlerRpcUrl: ${bundlerRpcUrl}`
    );

    const response = (await wrapRpc(
      async () =>
        axios.post(bundlerRpcUrl, payload, {
          headers: {
            'Content-Type': 'application/json'
          }
        }),
      rpcProviders.PIMLICO
    )) as AxiosResponse;

    if (response.data.error) {
      Logger.error('sendUserOperationToBundler', response.data.error);
      if (response.data.error.data) {
        Logger.error('sendUserOperationToBundler', response.data.error.data);
      }
      throw new Error(`Bundler Error: ${response.data.error.message}`);
    }

    if (!response.data.result) {
      throw new Error('Bundler did not return a result');
    }

    return response.data.result as string;
  } catch (error: unknown) {
    Logger.error(
      'sendUserOperationToBundler',
      error instanceof Error ? error.message : 'Unknown error'
    );
    throw error;
  }
}
