import { ethers } from 'ethers';
import { SCROLL_CONFIG } from '../constants/networks';
import * as crypto from 'crypto';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts';


export interface PhoneNumberToAddress {
    hashedPrivateKey: string;
    privateKey: string;
    publicKey: string;
}

function phoneNumberToAddress(phoneNumber: string): PhoneNumberToAddress {
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
        throw new Error('Seed private key not found in environment variables');
    }

    // Create a deterministic seed for generating the wallet
    const seed = seedPrivateKey + phoneNumber;

    // Generate a deterministic private key
    const privateKey = '0x' + crypto.createHash('sha256').update(seed).digest('hex');

    // Create a wallet from the private key
    const wallet = new ethers.Wallet(privateKey);

    // Get the public key of the wallet
    const publicKey = wallet.address;

    // Hash the private key for storage
    const hashedPrivateKey = crypto.createHash('sha256').update(privateKey).digest('hex');

    return {
        hashedPrivateKey,
        privateKey,
        publicKey
    };
}

export interface ComputedAddress {
    proxyAddress: string;
    EOAAddress: string;
    privateKey: string;
}


export async function computeProxyAddressFromPhone(phoneNumber: string): Promise<ComputedAddress> {
    const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL, {
        name: "scroll-sepolia",
        chainId: 534351,
    });

    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const factory = ChatterPayWalletFactory__factory.connect(SCROLL_CONFIG.CHATTER_PAY_WALLET_FACTORY_ADDRESS, backendSigner);
    
    // Convert phone number to Ethereum address
    const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(phoneNumber);

    // Use the contract's computeProxyAddress function to get the address of the proxy
    const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, { gasLimit: 1000000 });

    const code = await provider.getCode(proxyAddress);
    if (code === '0x') {
        console.log(`Creating new wallet for EOA: ${ownerAddress.publicKey}, will result in: ${proxyAddress}...`);
        const tx = await factory.createProxy(ownerAddress.publicKey, { gasLimit: 1000000 });
        await tx.wait();
    }

    console.log("Data: ", JSON.stringify({
        proxyAddress,
        EOAAddress: ownerAddress.publicKey,
    }));

    return {
        proxyAddress,
        EOAAddress: ownerAddress.publicKey,
        privateKey: ownerAddress.hashedPrivateKey
    }
}