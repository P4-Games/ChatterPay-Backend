import { ethers, BigNumber } from 'ethers';

import { getUserOpHash } from '../utils/userOperation';
import { PackedUserOperation } from '../types/userOperation';

/**
 * Decodes the callData of a UserOperation and logs the decoded information.
 * @param callData - The callData to decode.
 */
export function decodeCallData(callData: string) {
    const iface = new ethers.utils.Interface([
        "function execute(address dest, uint256 value, bytes calldata func)"
    ]);
    const decoded = iface.decodeFunctionData("execute", callData);
    console.log("Decoded callData:");
    console.log("  Destination:", decoded.dest);
    console.log("  Value:", decoded.value.toString());
    console.log("  Function:", decoded.func);
    
    // Try to decode the inner function call (transfer)
    try {
        const tokenIface = new ethers.utils.Interface([
            "function transfer(address to, uint256 amount)"
        ]);
        const innerDecoded = tokenIface.decodeFunctionData("transfer", decoded.func);
        console.log("Decoded transfer:");
        console.log("  To:", innerDecoded.to);
        console.log("  Amount:", innerDecoded.amount.toString());
    } catch (error) {
        console.log("Failed to decode inner function:", error);
    }
}

/**
 * Creates a user operation for token transfer.
 * 
 * @param entrypoint - The entrypoint contract instance.
 * @param chatterPay - The ChatterPay contract instance.
 * @param erc20 - The ERC20 token contract instance.
 * @param to - The recipient's address.
 * @param amount - The amount of tokens to transfer.
 * @param proxyAddress - The proxy address to use for the operation.
 * @returns A promise that resolves to the created UserOperation.
 */
export async function createUserOperation(
    entrypoint: ethers.Contract,
    chatterPay: ethers.Contract,
    erc20: ethers.Contract,
    to: string,
    amount: string,
    proxyAddress: string,
): Promise<PackedUserOperation> {
    console.log("Creating UserOperation...");
    console.log("Proxy Address:", proxyAddress);
    console.log("To Address:", to);
    console.log("Amount:", amount);

    if (!ethers.utils.isAddress(to)) {
        throw new Error("Invalid 'to' address");
    }

    let amount_bn;
    try {
        amount_bn = ethers.utils.parseUnits(amount, 18);
    } catch (error) {
        throw new Error("Invalid amount");
    }
    console.log("Amount in BigNumber:", amount_bn.toString());

    const transferEncode = erc20.interface.encodeFunctionData("transfer", [to, amount_bn]);
    console.log("Transfer Encode:", transferEncode);

    const transferCallData = chatterPay.interface.encodeFunctionData("execute", [erc20.address, 0, transferEncode]);
    console.log("Transfer Call Data:", transferCallData);

    const nonce = await entrypoint.getNonce(proxyAddress, 0);
    console.log("Proxy Nonce:", nonce.toString());

    const verificationGasLimit = BigNumber.from(120532);
    const callGasLimit = BigNumber.from(410000);
    const preVerificationGas = BigNumber.from(255943); 
    const maxFeePerGas = BigNumber.from(ethers.utils.parseUnits("10", "gwei"));
    const maxPriorityFeePerGas = BigNumber.from(ethers.utils.parseUnits("1", "gwei"));

    const userOp: PackedUserOperation = {
        sender: proxyAddress,
        nonce,
        initCode: "0x",
        callData: transferCallData,
        callGasLimit,
        verificationGasLimit,
        preVerificationGas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        paymasterAndData: "0x",
        signature: "0x",  // Inicialmente vacío, se llenará más tarde
    };

    return userOp;
}

/**
 * Calculates the prefund amount required for a UserOperation.
 * @param userOp - The UserOperation to calculate the prefund for.
 * @returns A promise that resolves to the calculated prefund amount as a BigNumber.
 */
export async function calculatePrefund(userOp: PackedUserOperation): Promise<BigNumber> {
    try {
        const {verificationGasLimit} = userOp;
        const {callGasLimit} = userOp;
        const {preVerificationGas} = userOp;
        const {maxFeePerGas} = userOp;
        
        const requiredGas = verificationGasLimit
            .add(callGasLimit)
            .add(preVerificationGas);

        const prefund = requiredGas.mul(maxFeePerGas);

        console.log("Prefund calculation details:");
        console.log(`Verification Gas Limit: ${verificationGasLimit.toString()}`);
        console.log(`Call Gas Limit: ${callGasLimit.toString()}`);
        console.log(`Pre-Verification Gas: ${preVerificationGas.toString()}`);
        console.log(`Max Fee Per Gas: ${ethers.utils.formatUnits(maxFeePerGas, "gwei")} gwei`);
        console.log(`Total Required Gas: ${requiredGas.toString()}`);
        console.log(`Calculated Prefund: ${ethers.utils.formatEther(prefund)} ETH`);

        return prefund;
    } catch (error) {
        console.error("Error calculating prefund:", error);
        throw new Error("Failed to calculate prefund");
    }
}

/**
 * Ensures that the account associated with the UserOperation has sufficient prefund.
 * @param entrypoint - The entrypoint contract instance.
 * @param userOp - The UserOperation to check and fund.
 * @param signer - The signer wallet.
 */
export async function ensureAccountHasPrefund(
    entrypoint: ethers.Contract,
    userOp: PackedUserOperation,
    signer: ethers.Wallet
): Promise<void> {
    try {
        const prefund = await calculatePrefund(userOp);
        const balance = await entrypoint.balanceOf(userOp.sender);
        
        console.log(`Required prefund: ${ethers.utils.formatEther(prefund)} ETH`);
        console.log(`Current balance: ${ethers.utils.formatEther(balance)} ETH`);
        
        if (balance.lt(prefund)) {
            const missingFunds = prefund.sub(balance);
            console.log(`Depositing ${ethers.utils.formatEther(missingFunds)} ETH to account`);
            const tx = await entrypoint.depositTo(userOp.sender, { value: missingFunds });
            await tx.wait();
            console.log("Deposit transaction confirmed");
        } else {
            console.log("Account has sufficient prefund");
        }
    } catch (error) {
        console.error("Error ensuring account has prefund:", error);
        throw error;
    }
}

/**
 * Simulates the validation of a UserOperation.
 * @param entrypoint - The entrypoint contract instance.
 * @param userOperation - The UserOperation to simulate.
 */
export async function simulateValidation(
    entrypoint: ethers.Contract,
    userOperation: PackedUserOperation
) {
    try {
        await entrypoint.callStatic.simulateValidation(userOperation);
        console.log("Local simulation successful");
    } catch (error) {
        console.error("Local simulation failed:", error);
    }
}

/**
 * Signs the UserOperation, replicating the contract's signature verification process.
 * 
 * @param userOperation - The UserOperation object.
 * @param entryPointAddress - The address of the EntryPoint contract.
 * @param signer - The ethers.js Wallet instance representing the signer.
 * @returns The UserOperation with the signature field populated.
 */
export async function signUserOperation(
    userOperation: PackedUserOperation,
    entryPointAddress: string,
    signer: ethers.Wallet
): Promise<PackedUserOperation> {
    const chainId = await signer.getChainId();
    console.log("Chain ID:", chainId);

    console.log("Computing userOpHash...");
    const userOpHash = getUserOpHash(userOperation, entryPointAddress, chainId);
    console.log("UserOpHash:", userOpHash);

    // Sign the userOpHash digest directly
    const signature = await signer.signMessage(ethers.utils.arrayify(userOpHash));
    console.log("Generated signature:", signature);

    // Verify the signature
    const recoveredAddress = ethers.utils.verifyMessage(ethers.utils.arrayify(userOpHash), signature);
    console.log("Recovered address:", recoveredAddress);
    console.log("Signer address:", await signer.getAddress());

    if (recoveredAddress.toLowerCase() !== (await signer.getAddress()).toLowerCase()) {
        throw new Error("Signature verification failed on client side");
    }

    return { ...userOperation, signature };
}