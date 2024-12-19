import { ethers, BigNumber } from 'ethers';

import { getUserOpHash } from '../utils/userOperation';
import { PackedUserOperation } from '../types/userOperation';

/**
 * Creates a generic user operation for any type of transaction.
 */
export async function createGenericUserOperation(
    callData: string,
    sender: string,
    nonce: BigNumber,
): Promise<PackedUserOperation> {
    console.log("Creating Generic UserOperation...");
    console.log("Sender Address:", sender);
    console.log("Call Data:", callData);
    console.log("Nonce:", nonce.toString());


    // Use high fixed values for gas
    const userOp: PackedUserOperation = {
        sender,
        nonce,
        initCode: "0x",
        callData,
        verificationGasLimit: BigNumber.from(74908),
        callGasLimit: BigNumber.from(79728),
        preVerificationGas: BigNumber.from(94542),
        maxFeePerGas: BigNumber.from(ethers.utils.parseUnits("24", "gwei")),
        maxPriorityFeePerGas: BigNumber.from(ethers.utils.parseUnits("2", "gwei")),
        paymasterAndData: "0x", // Will be filled by the paymaster service
        signature: "0x", // Empty signature initially
    };

    return userOp;
}

/**
 * Creates the encoded call data for a token transfer.
 */
export function createTransferCallData(
    chatterPay: ethers.Contract,
    erc20: ethers.Contract,
    to: string,
    amount: string,
): string {
    if (!ethers.utils.isAddress(to)) {
        throw new Error("Invalid 'to' address");
    }

    let amount_bn;
    try {
        amount_bn = ethers.utils.parseUnits(amount, 18);
    } catch (error) {
        throw new Error("Invalid amount");
    }

    const transferEncode = erc20.interface.encodeFunctionData("transfer", [to, amount_bn]);
    console.log("Transfer Encode:", transferEncode);

    const callData = chatterPay.interface.encodeFunctionData("execute", [erc20.address, 0, transferEncode]);
    console.log("Transfer Call Data:", callData);

    return callData;
}

/**
 * Signs the UserOperation.
 */
export async function signUserOperation(
    userOperation: PackedUserOperation,
    entryPointAddress: string,
    signer: ethers.Wallet
): Promise<PackedUserOperation> {
    console.log("\nSigning UserOperation...");

    const chainId = await signer.getChainId();
    console.log("Chain ID:", chainId);

    console.log("Computing userOpHash...");
    const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);
    console.log("UserOpHash:", userOpHash);

    const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
    console.log("Generated signature:", signature);

    const recoveredAddress = ethers.utils.verifyMessage(ethers.utils.arrayify(userOpHash), signature);
    console.log("Recovered address:", recoveredAddress);
    console.log("Signer address:", await signer.getAddress());

    if (recoveredAddress.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
        throw new Error("Signature verification failed on client side");
    }

    console.log("UserOperation signed successfully");
    return { ...userOperation, signature };
}