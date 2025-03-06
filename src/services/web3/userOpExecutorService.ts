import { ethers } from 'ethers';

import { Logger } from '../../helpers/loggerHelper';
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
  timeout = 300000, // 5 minutes
  interval = 5000 // 5 seconds
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
            const elapsed = Date.now() - startTime;
            Logger.log('waitForUserOperationReceipt', `Retrying... ${elapsed} / ${timeout} ms`);
            setTimeout(checkReceipt, interval);
          } else {
            reject(
              new Error('waitForUserOperationReceipt: Timeout waiting for user operation receipt')
            );
          }
        })
        .catch((error) => {
          if (Date.now() - startTime < timeout) {
            const elapsed = Date.now() - startTime;
            Logger.log(
              'waitForUserOperationReceipt',
              `Retrying after error... ${elapsed} / ${timeout} ms`
            );
            setTimeout(checkReceipt, interval);
          } else {
            reject(error);
          }
        });
    };

    checkReceipt();
  });
}
