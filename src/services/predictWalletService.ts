import { ethers } from 'ethers';
import { SCROLL_CONFIG } from '../constants/networks';
import * as crypto from 'crypto';


const factoryABI = [
    "function getProxyBytecode(address _owner) public view returns (bytes memory)",
    "function computeProxyAddress(address _owner) public view returns (address)"
];

export interface PhoneNumberToAddress {
    hashedPrivateKey: string;
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
        publicKey
    };
}

export interface ComputedAddress {
    proxyAddress: string;
    EOAAddress: string;
    privateKey: string;
}

export async function computeProxyAddressFromPhone(phoneNumber: string): Promise<ComputedAddress> {
const provider = new ethers.providers.JsonRpcProvider("https://421614.rpc.thirdweb.com/3ee52f972b1618dca8b7a040475915f3", {
        name: "arbitrum-sepolia",
        chainId: 421614,
    });

    const factory = new ethers.Contract(SCROLL_CONFIG.CHATTER_PAY_WALLET_FACTORY_ADDRESS, factoryABI, provider);

    // Convert phone number to Ethereum address
    const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(phoneNumber);

    // Use the contract's computeProxyAddress function directly
    console.log('Computing proxy address...', JSON.stringify(ownerAddress));
    const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, { gasLimit: 1000000 });

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