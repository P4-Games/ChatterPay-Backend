import { ethers , Contract, BigNumber } from 'ethers';

/**
 * Execute a transaction with a dynamic gas limit.
 * @param contract - Instance of the contract to call.
 * @param methodName - Name of the method to call.
 * @param args - Arreglo de argumentos para el método.
 * @param gasBufferPercentage - Percentage of gas to add to the estimated gas.
 * @returns Transaction receipt.
 */
export async function executeWithDynamicGas(
    contract: Contract,
    methodName: string,
    args: unknown[],
    gasBufferPercentage: number = 10
) {
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
    console.debug('estimatedGas:', estimatedGas.toString());
    console.debug('gasLimit:', gasLimit.toString());
    // Opciones para la transacción
    const txOptions = {
        gasLimit,
    };

    // Enviar la transacción utilizando el gas calculado
    const tx = await contract[methodName](...args, txOptions);

    // Esperar a que la transacción se confirme
    const receipt = await tx.wait();

    return {
        hash: tx.hash,
        transactionHash: receipt.transactionHash,
        receipt: tx
    }
}

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

export async function getDynamicGas( contract: Contract, methodName: string, args: unknown[], gasBufferPercentage: number = 10 ): Promise<BigNumber> {
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

    return gasLimit;
}

/**
 * Calculate gas limit based on the address and call data.
 * 
 * @param provider - An ethers provider instance.
 * @param to - The address to which the transaction is sent.
 * @param callData - The call data for the transaction.
 * @param gasBufferPercentage - Percentage of gas to add to the estimated gas.
 * @returns Gas limit for the transaction.
 * @throws Error if the gas estimation fails.
 */
export async function getDynamicGas_callData(
    provider: ethers.providers.Provider,
    to: string,
    callData: string,
    gasBufferPercentage: number = 10
): Promise<BigNumber> {
    try {
        // Estimar el gas necesario para la transacción
        const estimatedGas: BigNumber = await provider.estimateGas({
            to,
            data: callData,
        });

        // Aplicar el buffer al gas estimado
        const gasLimit: BigNumber = estimatedGas
            .mul(BigNumber.from(100 + gasBufferPercentage))
            .div(BigNumber.from(100));

        return gasLimit;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to estimate gas: ${error.message}`);
        } else {
            throw new Error(`Failed to estimate gas: ${error}`);
        }
    }
}