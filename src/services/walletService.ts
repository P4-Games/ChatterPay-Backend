import { ethers } from 'ethers';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts/factories/ChatterPayWalletFactory__factory';
import { ChatterPay__factory } from '../types/ethers-contracts/factories/ChatterPay__factory';
import { SCROLL_CONFIG } from '../constants/networks';
import chatterPayABI from "../chatterPayABI.json"
const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);
const signer = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

/**
 * Flujo: 
    Si el usuario no tiene wallet:
        1. Crear una wallet con una private key que guardamos en la bd (EOA)
        2. La fondeo con eth
        3. Con esa wallet llamamos a la funcion del contrato computeProxyAddress para obtener el address futuro de la smart account, usando el address de la wallet EOA generada
        4. Cuando tengamos la UserOperation, ahi firmamos esa transaccion con la EOA del usuario y se la manda al entry point (0x0000000071727De22E5E9d8BAf0edAc6f37da032)
    
    Si el usuario tiene wallet:
        0. Obtenemos la private key del usuario de la bd (user -> signing_key)
        1. Llamamos a la funcion del contrato computeProxyAddress para obtener el address de la smart account
        2. Cuando tengamos la UserOperation, ahi firmamos esa transaccion con la EOA del usuario y se la manda al entry point desde el signer del backend (0x0000000071727De22E5E9d8BAf0edAc6f37da032)
 */
export async function sendUserOperation(
    from: string,
    to: string,
    tokenAddress: string,
    amount: string
) {
    const factory = ChatterPayWalletFactory__factory.connect(SCROLL_CONFIG.CHATTER_PAY_WALLET_FACTORY_ADDRESS, signer);

    // Check if wallet exists
    console.log(`Checking if wallet exists for ${from}...`);
    let smartAccountAddress = await factory.computeProxyAddress(from, { gasLimit: 100000 });
    const code = await provider.getCode(smartAccountAddress);
    
    console.log(`Wallet code: ${code}`);
    if (code === '0x') {
        // Create new wallet if it doesn't exist
        console.log(`Creating new wallet for ${from}...`);
        const tx = await factory.createProxy(from, { gasLimit: 100000 });
        await tx.wait();
        smartAccountAddress = await factory.computeProxyAddress(from, { gasLimit: 100000 });
    }

    console.log(`Wallet address: ${smartAccountAddress}, setting up ChatterPay contract...`);
    const chatterPay = new ethers.Contract(SCROLL_CONFIG.CHATTER_PAY_ADDRESS, chatterPayABI, signer);

    // Prepare the transaction data
    console.log(`Preparing transaction data...`);
    const erc20 = new ethers.Contract(tokenAddress, ['function transfer(address to, uint256 amount)'], signer);
    const amount_bn = ethers.utils.parseUnits(amount, 18);
    const transferEncode = erc20.interface.encodeFunctionData("transfer", [to, amount_bn])

    const callData = chatterPay.interface.encodeFunctionData("execute", [
        tokenAddress,
        0,
        transferEncode
    ]);


    console.log('xxxxxxxxxxxxxxxxxxxxxxx')

    try {
        // Check balance of the signer
        console.log('1')
        const balance = await signer.getBalance();
        console.log('2')
        const minBalance = ethers.utils.parseEther("0.001");
        console.log('3', balance, minBalance)

        if (balance.lt(minBalance)) {
            // Fund the wallet with 0.001 ETH if balance is less than 0.001 ETH
            console.log(`Funding wallet with ${ethers.utils.formatEther(minBalance)} ETH...`);
            const ethToSend = minBalance;
            const fundingTx = await signer.sendTransaction({
                to: signer.address,
                value: ethToSend,
                gasLimit: 21000
            });
            await fundingTx.wait();
            console.log(`Funded wallet with ${ethers.utils.formatEther(ethToSend)} ETH`);
        }

        console.log(`Sending the transaction...`);
        // Send the transaction
        const tx = await signer.sendTransaction({
            to: smartAccountAddress,
            data: callData,
            gasLimit: 50000,
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
