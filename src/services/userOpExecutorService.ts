import { ethers } from 'ethers';
import { FastifyInstance } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
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
 * Executes a user operation by creating, signing, sending, and waiting for the transaction receipt.
 * It uses the global Fastify context to access network configuration and backend services.
 *
 * @param {FastifyInstance} fastify - The Fastify instance providing the network and backend services.
 * @param {string} callData - The data for the transaction call.
 * @param {ethers.Wallet} signer - The signer used to sign the user operation.
 * @param {string} senderAddress - The address of the sender initiating the user operation.
 * @returns {Promise<UserOperationReceiptData>} The receipt data of the user operation once the transaction is mined.
 */
export async function executeUserOperation(
  fastify: FastifyInstance,
  callData: string,
  signer: ethers.Wallet,
  senderAddress: string
): Promise<UserOperationReceiptData> {
  Logger.log('executeUserOperation', 'Starting executeUserOperation.');
  Logger.log('executeUserOperation', 'Sender address:', senderAddress);
  Logger.log('executeUserOperation', 'Call data:', callData);

  const { networkConfig, backendSigner, provider } = fastify;
  Logger.log(
    'executeUserOperation',
    'Network config loaded. Entry point:',
    networkConfig.contracts.entryPoint
  );

  const entrypointABI = await getEntryPointABI();
  const entrypointContract = new ethers.Contract(
    networkConfig.contracts.entryPoint,
    entrypointABI,
    backendSigner
  );
  Logger.log('executeUserOperation', 'EntryPoint contract initialized');

  // Get the nonce for the sender
  Logger.log('executeUserOperation', 'Fetching nonce for sender.', senderAddress);
  const nonce = await entrypointContract.getNonce(senderAddress, 0);
  Logger.log('executeUserOperation', 'Nonce:', nonce.toString());

  // Create, add paymaster data, and sign the UserOperation
  Logger.log('executeUserOperation', 'Creating generic user operation.');
  let userOperation = await createGenericUserOperation(callData, senderAddress, nonce);
  Logger.log('executeUserOperation', 'Generic user operation created');

  Logger.log('executeUserOperation', 'Adding paymaster data.');
  userOperation = await addPaymasterData(
    userOperation,
    networkConfig.contracts.paymasterAddress!,
    backendSigner
  );
  Logger.log('executeUserOperation', 'Paymaster data added');

  Logger.log('executeUserOperation', 'Signing user operation.');
  userOperation = await signUserOperation(
    userOperation,
    networkConfig.contracts.entryPoint,
    signer
  );
  Logger.log('executeUserOperation', 'User operation signed');

  // Send the user operation to the bundler and wait for the receipt
  Logger.log('executeUserOperation', 'Sending user operation to bundler');
  const bundlerResponse = await sendUserOperationToBundler(
    networkConfig.rpc,
    userOperation,
    networkConfig.contracts.entryPoint
  );
  Logger.log('executeUserOperation', 'Bundler response:', bundlerResponse);

  Logger.log('executeUserOperation', 'Waiting for transaction to be mined.');
  const receipt = await waitForUserOperationReceipt(provider, bundlerResponse);
  Logger.log('executeUserOperation', 'Transaction receipt:', JSON.stringify(receipt));

  // Check if the receipt indicates a successful transaction
  if (!receipt?.success) {
    throw new Error('executeUserOperation: Transaction failed or not found');
  }

  Logger.log(
    'executeUserOperation',
    'Transaction confirmed in block:',
    receipt.receipt.blockNumber
  );
  return receipt.receipt;
}

/**
 * Waits for a user operation receipt to be available by polling the provider for the receipt hash.
 * It retries periodically until the receipt is found or a timeout occurs.
 *
 * @param {ethers.providers.JsonRpcProvider} provider - The JSON RPC provider to communicate with the Ethereum network.
 * @param {string} userOpHash - The hash of the user operation to wait for.
 * @param {number} timeout - The maximum time to wait for the receipt, in milliseconds. Default is 60000ms.
 * @param {number} interval - The interval between retries, in milliseconds. Default is 5000ms.
 * @returns {Promise<UserOperationReceipt>} The user operation receipt when available.
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
            reject(
              new Error('waitForUserOperationReceipt: Timeout waiting for user operation receipt')
            );
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
