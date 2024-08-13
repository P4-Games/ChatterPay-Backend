import { ethers } from 'ethers';
import { SCROLL_CONFIG } from '../constants/networks';
import * as crypto from 'crypto';
import User from '../models/user';

const provider = new ethers.providers.JsonRpcProvider("https://public.stackup.sh/api/v1/node/arbitrum-sepolia");

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

    // Create a seed for generating a new wallet
    const seed = seedPrivateKey + phoneNumber;

    // Generate a new wallet using the seed
    const wallet = ethers.Wallet.createRandom();

    // Get the public key and private key of the new wallet
    const publicKey = wallet.address;
    const userPrivateKey = wallet.privateKey;

    // Hash the user's private key using the seed
    const hashedPrivateKey = crypto.createHash('sha256').update(seed + userPrivateKey).digest('hex');

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
    const factory = new ethers.Contract(SCROLL_CONFIG.CHATTER_PAY_WALLET_FACTORY_ADDRESS, factoryABI, provider);

    // Convert phone number to Ethereum address
    const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(phoneNumber);

    // Use the contract's computeProxyAddress function directly
    console.log('Computing proxy address...', JSON.stringify(ownerAddress));
    const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, { gasLimit: 1000000 });

    return {
        proxyAddress,
        EOAAddress: ownerAddress.publicKey,
        privateKey: ownerAddress.hashedPrivateKey
    }
}