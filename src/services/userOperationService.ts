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

    // Use high fixed values for gas
    const userOp: PackedUserOperation = {
        sender: proxyAddress,
        nonce,
        initCode: "0x",
        callData: transferCallData,
        verificationGasLimit: BigNumber.from(74908),
        callGasLimit: BigNumber.from(79728),
        preVerificationGas: BigNumber.from(94542),
        maxFeePerGas: BigNumber.from(ethers.utils.parseUnits("24", "gwei")),
        maxPriorityFeePerGas: BigNumber.from(ethers.utils.parseUnits("2", "gwei")),
        paymasterAndData: "0xDb76177b0b3fe903B12EDfa2c34929cE9512B1dd",
        signature: "0x", // Empty signature initially
    };

    return userOp;
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

/**
 * Calculates the prefund amount required for a UserOperation.
 */
export async function calculatePrefund(userOp: PackedUserOperation): Promise<BigNumber> {
    try {
        const { verificationGasLimit, callGasLimit, preVerificationGas, maxFeePerGas } = userOp;

        const requiredGas = verificationGasLimit
            .add(callGasLimit)
            .add(preVerificationGas);

        const prefund = requiredGas.mul(maxFeePerGas);

        console.log("\nPrefund calculation details:");
        console.log(`- Verification Gas Limit: ${verificationGasLimit.toString()}`);
        console.log(`- Call Gas Limit: ${callGasLimit.toString()}`);
        console.log(`- Pre-Verification Gas: ${preVerificationGas.toString()}`);
        console.log(`- Max Fee Per Gas: ${ethers.utils.formatUnits(maxFeePerGas, "gwei")} gwei`);
        console.log(`- Total Required Gas: ${requiredGas.toString()}`);
        console.log(`- Calculated Prefund: ${ethers.utils.formatEther(prefund)} ETH`);

        return prefund;
    } catch (error) {
        console.error("Error calculating prefund:", error);
        throw new Error("Failed to calculate prefund");
    }
}

/**
 * Ensures that the account has sufficient prefund with detailed logging.
 */
export async function ensureAccountHasPrefund(
    entrypoint: ethers.Contract,
    userOp: PackedUserOperation,
    signer: ethers.Wallet
): Promise<void> {
    try {
        const prefund = await calculatePrefund(userOp);
        const balance = await entrypoint.balanceOf(userOp.sender);

        console.log("\nChecking prefund requirements:");
        console.log(`- Required prefund: ${ethers.utils.formatEther(prefund)} ETH`);
        console.log(`- Current balance: ${ethers.utils.formatEther(balance)} ETH`);

        if (balance.lt(prefund)) {
            const missingFunds = prefund.sub(balance);
            console.log(`\nDepositing ${ethers.utils.formatEther(missingFunds)} ETH to account`);
            
            const tx = await entrypoint.depositTo(userOp.sender, { 
                value: missingFunds,
                gasLimit: 500000
            });
            await tx.wait();
            console.log("Deposit transaction confirmed");
            
            // Verify the new balance
            const newBalance = await entrypoint.balanceOf(userOp.sender);
            console.log(`New balance after deposit: ${ethers.utils.formatEther(newBalance)} ETH`);
        } else {
            console.log("Account has sufficient prefund");
        }
    } catch (error) {
        console.error("Error ensuring account has prefund:", error);
        throw error;
    }
}