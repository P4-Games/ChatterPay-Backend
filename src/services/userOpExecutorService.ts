import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import { Logger } from '../utils/loggerHelper';
import { getEntryPointABI } from './bucketService';
import { addPaymasterData } from './paymasterService';
import { sendUserOperationToBundler } from './bundlerService';
import { signUserOperation, createGenericUserOperation } from './userOperationService';
import { UserOperationReceipt, UserOperationReceiptData } from '../types/userOperation';

declare module 'fastify' {
  interface FastifyInstance {
    backendSigner: ethers.Signer;
    provider: ethers.providers.JsonRpcProvider;
  }
}

/**
 *
 * Creates, signs, sends and waits for a UserOperation in one go.
 * Uses the global Fastify context for network configuration and backend services.
 *
 * @param fastify
 * @param callData
 * @param signer
 * @param senderAddress
 * @returns
 */
export async function executeUserOperation(
  fastify: FastifyInstance,
  callData: string,
  signer: ethers.Wallet,
  senderAddress: string
): Promise<UserOperationReceiptData> {
  Logger.log('Starting executeUserOperation.');
  Logger.log('Sender address:', senderAddress);
  Logger.log('Call data:', callData);

  const { networkConfig, backendSigner, provider } = fastify;
  Logger.log('Network config loaded. Entry point:', networkConfig.contracts.entryPoint);

  const entrypointABI = await getEntryPointABI();
  const entrypointContract = new ethers.Contract(
    networkConfig.contracts.entryPoint,
    entrypointABI,
    backendSigner
  );
  Logger.log('EntryPoint contract initialized');

  // Get the nonce
  Logger.log('Fetching nonce for sender.', senderAddress);
  const nonce = await entrypointContract.getNonce(senderAddress, 0);
  Logger.log('Nonce:', nonce.toString());

  // Create, add paymaster and sign the UserOperation
  Logger.log('Creating generic user operation.');
  let userOperation = await createGenericUserOperation(callData, senderAddress, nonce);
  Logger.log('Generic user operation created');

  Logger.log('Adding paymaster data.');
  userOperation = await addPaymasterData(
    userOperation,
    networkConfig.contracts.paymasterAddress!,
    backendSigner
  );
  Logger.log('Paymaster data added');

  Logger.log('Signing user operation.');
  userOperation = await signUserOperation(
    userOperation,
    networkConfig.contracts.entryPoint,
    signer
  );
  Logger.log('User operation signed');

  // Send to bundler and wait for receipt
  Logger.log('Sending user operation to bundler');
  const bundlerResponse = await sendUserOperationToBundler(
    networkConfig.rpc,
    userOperation,
    networkConfig.contracts.entryPoint
  );
  Logger.log('Bundler response:', bundlerResponse);

  Logger.log('Waiting for transaction to be mined.');
  const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
  Logger.log('Transaction receipt:', JSON.stringify(receipt));

  if (!receipt?.success) {
    throw new Error('Transaction failed or not found');
  }

  Logger.log('Transaction confirmed in block:', receipt.receipt.blockNumber);
  return receipt.receipt;
}

/**
 *
 * @param provider
 * @param userOpHash
 * @param timeout
 * @param interval
 * @returns
 */
export async function waitForUserOperationReceipt(
  provider: ethers.providers.JsonRpcProvider,
  userOpHash: string,
  timeout = 60000,
  interval = 5000
): Promise<UserOperationReceipt> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const checkReceipt = () => {
      provider
        .send('eth_getUserOperationReceipt', [userOpHash])
        .then((receipt: UserOperationReceipt | null) => {
          if (receipt) {
            resolve(receipt);
          } else if (Date.now() - startTime < timeout) {
            setTimeout(checkReceipt, interval);
          } else {
            reject(new Error('Timeout waiting for user operation receipt'));
          }
        })
        .catch((error) => {
          if (Date.now() - startTime < timeout) {
            setTimeout(checkReceipt, interval);
          } else {
            reject(error);
          }
        });
    };

    checkReceipt();
  });
}
