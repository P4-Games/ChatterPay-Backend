import { ethers } from 'ethers';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts/factories/ChatterPayWalletFactory__factory';
import chatterPayABI from "../chatterPayABI.json";
import Blockchain, { IBlockchain } from '../models/blockchain';
import { computeProxyAddressFromPhone } from './predictWalletService';
import { tokenAddress } from '../controllers/transactionController';
import * as crypto from 'crypto';
import { SCROLL_CONFIG } from '../constants/networks';
import entryPoint from "../entryPoint.json";

export async function sendUserOperation(
    from: string,
    fromNumber: string,
    to: string,
    tokenAddress: string,
    amount: string,
    chain_id: number = 534351
) {
    const blockchain: IBlockchain | null = await Blockchain.findOne({ chain_id });
    
    if (!blockchain) {
        throw new Error(`Blockchain with chain_id ${chain_id} not found`);
    }else{
        console.log(`Blockchain with chain_id ${JSON.stringify(blockchain)} found`);
    }

    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
        throw new Error('Seed private key not found in environment variables');
    }

    // Create a deterministic seed for generating the wallet
    const seed = seedPrivateKey + fromNumber;

    // Generate a deterministic private key
    const privateKey = '0x' + crypto.createHash('sha256').update(seed).digest('hex');

    console.log(`Data: Phone number ${fromNumber}...`);
    const proxy = await computeProxyAddressFromPhone(fromNumber);
    const provider = new ethers.providers.JsonRpcProvider(blockchain.rpc);
    const signer = new ethers.Wallet(privateKey!, provider);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

    const factory = ChatterPayWalletFactory__factory.connect(blockchain.factoryAddress, backendSigner);

    const code = await provider.getCode(proxy.proxyAddress);
    if (code === '0x') {
        console.log(`Creating new wallet for EOA: ${proxy.EOAAddress}, will result in: ${proxy.proxyAddress}...`);
        const tx = await factory.createProxy(proxy.EOAAddress, { gasLimit: 1000000 });
        await tx.wait();
    }

    // await ensureSignerHasEth(signer, backendSigner, provider);

    const chatterPay = new ethers.Contract(proxy.proxyAddress, chatterPayABI, signer);
    const erc20 = new ethers.Contract(tokenAddress, [
        'function transfer(address to, uint256 amount) returns (bool)',
        'function balanceOf(address owner) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
    ], signer);

    await checkBalance(erc20, proxy.proxyAddress, amount);

    return await executeTransfer(erc20, chatterPay, to, amount, proxy.proxyAddress, signer, backendSigner);
}

export async function ensureSignerHasEth(signer: ethers.Wallet, backendSigner: ethers.Wallet, provider: ethers.providers.JsonRpcProvider) {
    const EOABalance = await provider.getBalance(await signer.getAddress());
    if (EOABalance.lt(ethers.utils.parseEther('0.0008'))) {
        console.log('Sending ETH to signer...');
        const tx = await backendSigner.sendTransaction({
            to: await signer.getAddress(),
            value: ethers.utils.parseEther('0.001'),
            gasLimit: 210000,
        });
        await tx.wait();
        console.log('ETH sent to signer');
    }
    console.log('Signer has enough ETH');
}

async function checkBalance(erc20: ethers.Contract, proxyAddress: string, amount: string) {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const balanceCheck = await erc20.balanceOf(proxyAddress);
    if (balanceCheck.lt(amount_bn)) {
        throw new Error(`Insufficient balance. Required: ${amount}, Available: ${ethers.utils.formatUnits(balanceCheck, 18)}`);
    }
}

async function executeTransfer(
    erc20: ethers.Contract,
    chatterPay: ethers.Contract,
    to: string,
    amount: string,
    proxyAddress: string,
    signer: ethers.Wallet,
    backendSigner: ethers.Wallet
) {
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const transferEncode = erc20.interface.encodeFunctionData("transfer", [to, amount_bn]);
    const transferCallData = chatterPay.interface.encodeFunctionData("execute", [erc20.address, 0, transferEncode]);

    const entrypoint = new ethers.Contract(SCROLL_CONFIG.ENTRY_POINT_ADDRESS, entryPoint, signer);

    // Obtener el nonce del contrato proxyAddress (deberás tener una forma de obtenerlo)
    const nonce = await signer.provider.getTransactionCount(proxyAddress) + 1;
    console.log("MY Nonce")
    console.log(nonce);

    // Example UserOperation
    const userOperation = {
        sender: proxyAddress,
        nonce: ethers.BigNumber.from(nonce).toHexString(), // Ensure nonce is a BigNumber
        initCode: "",
        callData: transferCallData,
        accountGasLimits: ethers.BigNumber.from("10000000"), // Ensure this is a BigNumber
        preVerificationGas: ethers.BigNumber.from(16777216), // Ensure this is a BigNumber
        gasFees: ethers.BigNumber.from("1000000"), // Ensure this is a BigNumber
        paymasterAndData: "",
        signature: ""
    };
    console.log("My user op")
    console.log(userOperation);

    // Codifica la operación (esto depende del contrato EntryPoint y cómo espera recibir la operación)
    const userOpHash = await entrypoint.getUserOpHash([
        userOperation.sender,
        userOperation.nonce,
        userOperation.initCode,
        userOperation.callData,
        userOperation.accountGasLimits,
        userOperation.preVerificationGas,
        userOperation.gasFees,
        userOperation.paymasterAndData,
        userOperation.signature
    ]);
    console.log("My hash")
    console.log(userOpHash);
    const userOpSignature = await signer.signMessage(userOpHash);

    // Asigna la firma al userOperation
    userOperation.signature = userOpSignature;

    try {
        // Enviar la User Operation a la EntryPoint
        const entrypoint_backend = new ethers.Contract(SCROLL_CONFIG.ENTRY_POINT_ADDRESS, entryPoint, backendSigner);

        const tx = await entrypoint_backend.handleOps(
            [userOperation], 
            signer.address,
            { gasLimit: 1000000 }
        );

        const receipt = await tx.wait();
        console.log(`User Operation execute confirmed in block ${receipt.blockNumber}`);
        return { transactionHash: receipt.transactionHash };

    } catch (error) {
        console.error('Error sending User Operation transaction:', error);
        throw error;
    }
}