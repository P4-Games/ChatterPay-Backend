import { ethers } from 'ethers';

export interface UserOperationReceiptData {
    transactionHash: string;
    transactionIndex: string;
    blockHash: string;
    blockNumber: string;
    from: string;
    to: string;
    cumulativeGasUsed: string;
    gasUsed: string;
    contractAddress: string | null;
    logs: Array<{
        address: string;
        topics: string[];
        data: string;
    }>;
    logsBloom: string;
    status: string;
}

export interface UserOperationReceipt {
    userOpHash: string;
    entryPoint: string;
    sender: string;
    nonce: string;
    paymaster: string;
    actualGasCost: string;
    actualGasUsed: string;
    success: boolean;
    reason: string;
    logs: Array<{
        address: string;
        topics: string[];
        data: string;
    }>;
    receipt: UserOperationReceiptData;
}

export async function waitForUserOperationReceipt(
    provider: ethers.providers.JsonRpcProvider,
    userOpHash: string,
    timeout = 60000,
    interval = 5000,
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
