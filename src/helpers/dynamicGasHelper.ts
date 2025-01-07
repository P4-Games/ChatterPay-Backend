import { Contract, BigNumber } from 'ethers';

import { Logger } from './loggerHelper';

/**
 * Get gas limit for a transaction w/ dynamic gas.
 *
 * @param contract - Instance of the contract to call.
 * @param methodName - Name of the method to call.
 * @param args - Array of arguments for the method.
 * @param gasBufferPercentage - Percentage of gas to add to the estimated gas.
 * @param defaultGasLimit - default gas limit: 7000000 (the maximum permitted by arb).
 * @returns Gas limit for the transaction.
 * @throws Error if the method does not exist in the contract.
 * @throws Error if the gas estimation fails.
 */
export async function getDynamicGas(
  contract: Contract,
  methodName: string,
  args: unknown[],
  gasBufferPercentage: number = 10,
  defaultGasLimit: BigNumber = BigNumber.from('7000000')
): Promise<BigNumber> {
  try {
    // Check if the method exists in the contract
    if (typeof contract[methodName] !== 'function') {
      throw new Error(`The method ${methodName} doesn't exist in contract.`);
    }

    // Try to estimate the gas required for the transaction
    const estimatedGas: BigNumber = await contract.estimateGas[methodName](...args);

    // Apply the buffer to the estimated gas
    const gasLimit: BigNumber = estimatedGas
      .mul(BigNumber.from(100 + gasBufferPercentage))
      .div(BigNumber.from(100));
    Logger.log(`Estimated gas limit for ${methodName}:`, gasLimit.toString());
    return gasLimit;
  } catch (error) {
    Logger.warn(`Gas estimation failed for ${methodName}:`, error);
    // If the estimation fails, use the default gas limit
    return defaultGasLimit;
  }
}
