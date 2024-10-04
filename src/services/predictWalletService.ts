import { ethers } from 'ethers';
import * as crypto from 'crypto';

import { getNetworkConfig } from './networkService';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts';

export interface PhoneNumberToAddress {
    hashedPrivateKey: string;
    privateKey: string;
    publicKey: string;
}

/**
 * Generates a deterministic Ethereum address from a phone number.
 *
 * @param {string} phoneNumber - The phone number to generate the address from.
 * @returns {PhoneNumberToAddress} An object containing the hashed private key, private key, and public key.
 * @throws {Error} If the seed private key is not found in environment variables.
 */
function phoneNumberToAddress(phoneNumber: string): PhoneNumberToAddress {
    const seedPrivateKey = process.env.PRIVATE_KEY;
    if (!seedPrivateKey) {
        throw new Error('Seed private key not found in environment variables');
    }

    const seed = seedPrivateKey + phoneNumber;
    const privateKey = `0x${crypto.createHash('sha256').update(seed).digest('hex')}`;
    const wallet = new ethers.Wallet(privateKey);
    const publicKey = wallet.address;
    const hashedPrivateKey = crypto.createHash('sha256').update(privateKey).digest('hex');

    return {
        hashedPrivateKey,
        privateKey,
        publicKey,
    };
}

export interface ComputedAddress {
    proxyAddress: string;
    EOAAddress: string;
    privateKey: string;
}

/**
 * Computes the proxy address for a given phone number.
 *
 * @param {string} phoneNumber - The phone number to compute the proxy address for.
 * @returns {Promise<ComputedAddress>} A promise that resolves to an object containing the proxy address, EOA address, and private key.
 * @throws {Error} If there's an error in the computation process.
 */
export async function computeProxyAddressFromPhone(phoneNumber: string): Promise<ComputedAddress> {
    const networkConfig = await getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc, {
        name: "arbitrum-sepolia",
        chainId: 421614,
    });

    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    const factory = ChatterPayWalletFactory__factory.connect(
        "0x18EaE7E630B3DE19126633B8cAfc60B6604Db06A", // @tomas hardcoded: networkConfig.contracts.factoryAddress
        backendSigner,
    );

    const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(phoneNumber);

    const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, {
        gasLimit: 1000000,
    });
    console.log(`Computed proxy address: ${proxyAddress}`);

    const code = await provider.getCode(proxyAddress);
    if (code === '0x') {
        console.log(
            `Creating new wallet for EOA: ${ownerAddress.publicKey}, will result in: ${proxyAddress}...`,
        );
        const tx = await factory.createProxy(ownerAddress.publicKey, { gasLimit: 1000000 });
        await tx.wait();
    }

    console.log(
        'Data: ',
        JSON.stringify({
            proxyAddress,
            EOAAddress: ownerAddress.publicKey,
        }),
    );

    return {
        proxyAddress,
        EOAAddress: ownerAddress.publicKey,
        privateKey: ownerAddress.hashedPrivateKey,
    };
}
