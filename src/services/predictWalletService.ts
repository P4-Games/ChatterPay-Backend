import { ethers } from 'ethers';
import { SCROLL_CONFIG } from '../constants/networks';

const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);

const factoryABI = [
    "function getProxyBytecode(address _owner) public view returns (bytes memory)",
    "function computeProxyAddress(address _owner) public view returns (address)"
];

function phoneNumberToAddress(phoneNumber: string): string {
    // Remove any non-digit characters from the phone number
    const cleanNumber = phoneNumber.replace(/\D/g, '');

    // Hash the cleaned phone number
    const hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(cleanNumber));

    // Take the last 20 bytes of the hash to create an Ethereum address
    return ethers.utils.getAddress('0x' + hash.slice(-40));
}

export async function computeProxyAddressFromPhone(phoneNumber: string): Promise<string> {
    const factory = new ethers.Contract(SCROLL_CONFIG.CHATTER_PAY_WALLET_FACTORY_ADDRESS, factoryABI, provider);

    // Convert phone number to Ethereum address
    const ownerAddress = phoneNumberToAddress(phoneNumber);

    // Use the contract's computeProxyAddress function directly
    return await factory.computeProxyAddress(ownerAddress, { gasLimit: 100000 });
}