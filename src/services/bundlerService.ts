import axios from 'axios';

import { PackedUserOperation } from '../types/userOperation';
import { serializeUserOperation } from '../utils/userOperation';

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
    userOperation: PackedUserOperation,
    entryPointAddress: string
): Promise<string> {
    try {
        const serializedUserOp = serializeUserOperation(userOperation);
        console.log("Serialized UserOperation:", JSON.stringify(serializedUserOp, null, 2));
        const payload = {
            jsonrpc: '2.0',
            method: 'eth_sendUserOperation',
            params: [serializedUserOp, entryPointAddress],
            id: Date.now(),
        };

        const response = await axios.post(bundlerUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (response.data.error) {
            console.error('Bundler returned an error:', response.data.error);
            if (response.data.error.data) {
                console.error('Bundler error data:', response.data.error.data);
            }
            throw new Error(`Bundler Error: ${response.data.error.message}`);
        }

        if (!response.data.result) {
            throw new Error('Bundler did not return a result');
        }

        return response.data.result as string;
    } catch (error: unknown) {
        console.error('Error sending user operation to bundler:', error instanceof Error ? error.message : 'Unknown error');
        throw error;
    }
}

/**
 * Estimates the gas that will be used in the UserOperation
 */
export async function estimateUserOperationGas(
    bundlerUrl: string,
    userOperation: PackedUserOperation,
    entryPointAddress: string
): Promise<void> {
    try {
        const serializedUserOp = serializeUserOperation(userOperation);
        const payload = {
            jsonrpc: '2.0',
            method: 'eth_estimateUserOperationGas',
            params: [serializedUserOp, entryPointAddress],
            id: Date.now(),
        };

        const response = await axios.post(bundlerUrl, payload, {
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (response.data.error) {
            console.error('Gas estimation error:', response.data.error);
            throw new Error(`Gas estimation failed: ${response.data.error.message}`);
        }

        console.log("Gas Estimation:", response.data.result);
        // You can use these estimates to update your userOperation if needed
    } catch (error) {
        console.error('Error estimating gas:', error);
        throw error;
    }
}