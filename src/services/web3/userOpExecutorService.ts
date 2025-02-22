import { ethers } from 'ethers';

import { UserOperationReceipt } from '../../types/userOperationType';

declare module 'fastify' {
  interface FastifyInstance {
    backendSigner: ethers.Signer;
    provider: ethers.providers.JsonRpcProvider;
  }
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
