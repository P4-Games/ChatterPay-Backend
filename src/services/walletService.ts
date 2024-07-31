import { ethers } from 'ethers';
import { Presets, Client } from 'userop';

const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)'
];

export async function sendUserOperation(
    userId: string,
    to: string,
    tokenAddress: string,
    amount: string
) {
    const rpcUrl = process.env.RPC_URL;
    const signingKey = process.env.SIGNING_KEY;
    const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

    if (!rpcUrl || !signingKey) {
        throw new Error("Missing RPC_URL or SIGNING_KEY in environment variables");
    }

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(signingKey, provider);

    console.log("EOA address:", await signer.getAddress());

    const builder = await Presets.Builder.Kernel.init(signer, rpcUrl, { entryPoint });
    const smartAccountAddress = builder.getSender();
    console.log("Smart Account address for user", userId, ":", smartAccountAddress);

    const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const amount_bn = ethers.utils.parseUnits(amount, 6);

    // Verificar el balance de la EOA
    const eoaBalance = await erc20.balanceOf(signer.address);
    console.log("EOA balance:", ethers.utils.formatUnits(eoaBalance, 6));

    if (eoaBalance.lt(amount_bn)) {
        throw new Error("Insufficient ERC20 balance in EOA");
    }

    // Transferir tokens de la EOA a la cuenta inteligente
    console.log("Transferring tokens from EOA to Smart Account...");
    const transferTx = await erc20.transfer(smartAccountAddress, amount_bn);
    await transferTx.wait();
    console.log("Transfer to Smart Account complete");

    // Verificar el balance de la cuenta inteligente
    const smartAccountBalance = await erc20.balanceOf(smartAccountAddress);
    console.log("Smart Account balance:", ethers.utils.formatUnits(smartAccountBalance, 6));

    const client = await Client.init(rpcUrl, { entryPoint });

    try {
        const userOp = builder.execute({
            value: 0,
            data: erc20.interface.encodeFunctionData("transfer", [to, amount_bn]),
            to: tokenAddress,
        })
            .setCallGasLimit(200000)
            .setVerificationGasLimit(300000)
            .setPreVerificationGas(50000)
            .setMaxPriorityFeePerGas(1000000000)

        console.log("UserOperation:", userOp.getOp());

        const res = await client.sendUserOperation(userOp, {
            //TODO - Buscar forma de subirle el gas
        });
        console.log(`UserOpHash: ${res.userOpHash}`);

        const ev = await res.wait();
        console.log(`Transaction hash: ${ev?.transactionHash ?? null}`);

        return {
            userOpHash: res.userOpHash,
            transactionHash: ev?.transactionHash,
        };
    } catch (error) {
        console.error('Error sending user operation:', error);
        throw error;
    }
}