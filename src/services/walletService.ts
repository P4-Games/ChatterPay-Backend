import { ethers } from 'ethers';
import { Presets, Client } from 'userop';

const ERC20_ABI = [
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)'
];

export async function sendUserOperation(
    from: string,
    to: string,
    tokenAddress: string,
    amount: string,
    chain_id: number
) {
    const rpcUrl = process.env.RPC_URL;
    const signingKey = process.env.SIGNING_KEY;
    const entryPoint = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
    const factoryAddress = process.env.FACTORY_ADDRESS;

    if (!rpcUrl || !signingKey || !factoryAddress) {
        throw new Error("Missing RPC_URL, SIGNING_KEY, or FACTORY_ADDRESS in environment variables");
    }

    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(signingKey, provider);

    console.log("EOA address:", await signer.getAddress());

    // Check if wallet exists in keystore
    const walletExists = await checkWalletExistsInKeystore(from);

    let smartAccountAddress: string;
    if (walletExists) {
        // If wallet exists, use the existing address
        smartAccountAddress = await getWalletAddressFromKeystore(from);
    } else {
        // If wallet doesn't exist, calculate the future address
        smartAccountAddress = calculateFutureWalletAddress(from, factoryAddress);
    }

    console.log("Smart Account address for user", from, ":", smartAccountAddress);

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
        const simpleAccount = await Presets.Builder.SimpleAccount.init(
            signer,
            rpcUrl,
            {
                entryPoint,
                factory: factoryAddress,
                salt: ethers.utils.hexZeroPad(ethers.utils.hexlify(from), 32) // Usar from como salt
            }
        );

        const callData = erc20.interface.encodeFunctionData("transfer", [to, amount_bn]);

        let userOp = simpleAccount.execute(tokenAddress, 0, callData);

        if (!walletExists) {
            // Si la wallet no existe, establecer el initCode
            userOp.setInitCode(createInitCode(factoryAddress, await signer.getAddress()));
        }

        console.log("UserOperation:", userOp);

        const res = await client.sendUserOperation(userOp);
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

function createInitCode(factoryAddress: string, owner: string): string {
    const encodedData = ethers.utils.defaultAbiCoder.encode(['address'], [owner]);
    const encodedFactory = ethers.utils.hexZeroPad(factoryAddress, 20);
    return ethers.utils.hexlify(ethers.utils.concat([encodedFactory, encodedData]));
}

// These functions need to be implemented
async function checkWalletExistsInKeystore(userId: string): Promise<boolean> {
    // Implementation to check if wallet exists in keystore
    throw new Error("Not implemented");
}

async function getWalletAddressFromKeystore(userId: string): Promise<string> {
    // Implementation to get wallet address from keystore
    throw new Error("Not implemented");
}

function calculateFutureWalletAddress(userId: string, factoryAddress: string): string {
    // Asumimos que esta es la función de inicialización del contrato proxy
    const initCodeHash = ethers.utils.keccak256("0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000" +
        factoryAddress.slice(2) +
        "5af43d82803e903d91602b57fd5bf3");

    // El salt será el userId convertido a bytes32
    const salt = ethers.utils.hexZeroPad(ethers.utils.hexlify(ethers.utils.toUtf8Bytes(userId)), 32);

    // Calculamos la dirección usando CREATE2
    const create2Input = ethers.utils.concat([
        ethers.utils.hexlify(0xff),
        factoryAddress,
        salt,
        initCodeHash
    ]);

    const addressBytes = ethers.utils.keccak256(create2Input);

    // Tomamos los últimos 20 bytes (40 caracteres) para obtener la dirección
    return ethers.utils.getAddress('0x' + addressBytes.slice(-40));
}