import { ethers } from 'ethers';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts/factories/ChatterPayWalletFactory__factory';
import chatterPayABI from "../chatterPayABI.json";
import Blockchain, { IBlockchain } from '../models/blockchain';

export async function sendUserOperation(
    from: string,
    to: string,
    tokenAddress: string,
    amount: string,
    createdAddress?: string,
    chain_id: number = 42161
) {

    const blockchain: IBlockchain = (await Blockchain.find({ chain_id }))?.[0];

    if (!blockchain) {
        throw new Error(`Blockchain with chain_id ${chain_id} not found`);
    }

    const provider = new ethers.providers.JsonRpcProvider(blockchain.rpc);
    console.log("Setting up wallet...", blockchain);
    const signer = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const factory = ChatterPayWalletFactory__factory.connect(blockchain.factoryAddress, signer);

    // Check if wallet exists
    console.log(`Checking if wallet exists for ${from}...`);
    let smartAccountAddress = from;
    const code = await provider.getCode(smartAccountAddress);

    if (code === '0x' && createdAddress) {
        // Create new wallet if it doesn't exist
        console.log(`Creating new wallet for ${smartAccountAddress}...`);
        const tx = await factory.createProxy(createdAddress, { gasLimit: 1000000 });
        let result = await tx.wait();
        console.log(JSON.stringify(result));
    }

    console.log(`Wallet address: ${smartAccountAddress}, setting up ChatterPay contract...`);
    const chatterPay = new ethers.Contract(smartAccountAddress, chatterPayABI, signer);

    // Prepare the transaction data
    console.log(`Preparing transaction data...`);
    const erc20 = new ethers.Contract(tokenAddress, [
        'function transfer(address to, uint256 amount)',
        'function balanceOf(address owner) view returns (uint256)',
    ], signer);
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    console.log("To: ", to)
    const transferEncode = erc20.interface.encodeFunctionData("transfer", [to, amount_bn])

    // Check balance of the wallet
    const balanceCheck = await erc20.balanceOf(smartAccountAddress);
    let balance = ethers.utils.formatUnits(balanceCheck, 18);

    console.log(`Balance of the wallet is ${ethers.utils.formatUnits(balanceCheck, 18)}`);

    /**
    if (parseFloat(balance) < 1) {
        //Mintear "amount" tokens al usuario que envia la solicitud
        const amountToMint = ethers.utils.parseUnits(amount, 18);
        
        console.log(`Funding wallet with 100,000 tokens...`);
        const tx = await erc20.mint(smartAccountAddress, amountToMint, { gasLimit: 300000 });
        await tx.wait();
        console.log(`Funded wallet with 100,000 tokens`);
    }
    
    const newbalance = await erc20.balanceOf(smartAccountAddress);
    console.log(`El nuevo balance del SCA es ${ethers.utils.formatUnits(newbalance, 18)}`);
        */

    const callData = chatterPay.interface.encodeFunctionData("execute", [
        tokenAddress,
        0,
        transferEncode
    ]);

    try {

        console.log(`Sending the transaction...`);
        const tx = await signer.sendTransaction({
            to: smartAccountAddress,
            data: callData,
            gasLimit: 1000000,
        });

        console.log(`Transaction hash: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

        return {
            transactionHash: tx.hash,
        };
    } catch (error) {
        console.error('Error sending transaction:', error);
        throw error;
    }
}
