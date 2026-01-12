import axios, { type AxiosResponse } from 'axios';
import { ethers } from 'ethers';
import { Logger } from '../../helpers/loggerHelper';
import { rpcProviders } from '../../types/commonType';
import type { PackedUserOperation } from '../../types/userOperationType';
import { wrapRpc } from './rpc/rpcService';

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

    const response = await wrapRpc<AxiosResponse>(
      {
        fn: async () =>
          axios.post(bundlerRpcUrl, payload, {
            headers: {
              'Content-Type': 'application/json'
            }
          }),
        name: 'axios.post',
        args: [bundlerRpcUrl, payload]
      },
      rpcProviders.PIMLICO
    );

    const { data } = response;

    if (data.error) {
      Logger.error('sendUserOperationToBundler', data.error);
      if (data.error.data) {
        Logger.error('sendUserOperationToBundler', data.error.data);
      }
      throw new Error(`Bundler Error: ${data.error.message}`);
    }

    if (!data.result) {
      throw new Error('Bundler did not return a result');
    }

    return data.result as string;
  } catch (error: unknown) {
    Logger.error(
      'sendUserOperationToBundler',
      error instanceof Error ? error.message : JSON.stringify(error)
    );
    throw error;
  }
}
