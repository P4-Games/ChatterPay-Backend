import { ethers, Contract, BigNumber } from 'ethers';

/**
 * Get gas limit for a transaction w/ dynamic gas.
 *
 * @param contract - Instance of the contract to call.
 * @param methodName - Name of the method to call.
 * @param args - Array of arguments for the method.
 * @param gasBufferPercentage - Percentage of gas to add to the estimated gas.
 * @returns Gas limit for the transaction.
 * @throws Error if the method does not exist in the contract.
 * @throws Error if the gas estimation fails.
 */

export async function getDynamicGas(
  contract: Contract,
  methodName: string,
  args: unknown[],
  gasBufferPercentage: number = 10
): Promise<BigNumber> {
  // Verificar que el método existe en el contrato
  if (typeof contract[methodName] !== 'function') {
    throw new Error(`The method ${methodName} doesnt exists in contract.`);
  }

  // Estimar el gas necesario para la transacción
  const estimatedGas: BigNumber = await contract.estimateGas[methodName](...args);

  // Aplicar el buffer al gas estimado
  const gasLimit: BigNumber = estimatedGas
    .mul(BigNumber.from(100 + gasBufferPercentage))
    .div(BigNumber.from(100));
  console.log('Gas limit:', gasLimit.toString());
  return gasLimit;
}


