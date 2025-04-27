import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';

import { gasService } from './web3/gasService';
import { Logger } from '../helpers/loggerHelper';
import { SIGNING_KEY } from '../config/constants';
import { IBlockchain } from '../models/blockchainModel';
import { generatePrivateKey } from '../helpers/SecurityHelper';
import { getChatterPayWalletFactoryABI } from './web3/abiService';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
import { mongoBlockchainService } from './mongo/mongoBlockchainService';
import { ChatterPayWalletFactory__factory } from '../types/ethers-contracts';

export interface PhoneNumberToAddress {
  hashedPrivateKey: string;
  privateKey: string;
  publicKey: string;
}

/**
 * Generates a deterministic Ethereum address based on a phone number and a chain ID.
 *
 * This function derives an Ethereum address by combining the phone number and chain ID
 * with the environment-defined seed private key. The result includes the hashed private key,
 * the private key, and the public key (Ethereum address).
 *
 * @param {string} phoneNumber - The phone number to generate the address from.
 * @param {string} chainId - The chain ID to include in the address generation.
 * @returns {PhoneNumberToAddress} An object containing:
 *   - `hashedPrivateKey`: A SHA-256 hash of the generated private key.
 *   - `privateKey`: The deterministic private key.
 *   - `publicKey`: The Ethereum address corresponding to the private key.
 *
 * @throws {Error} If the seed private key is not found in environment variables.
 */
function phoneNumberToAddress(phoneNumber: string, chainId: string): PhoneNumberToAddress {
  const privateKey = generatePrivateKey(getPhoneNumberFormatted(phoneNumber), chainId);
  const wallet = new ethers.Wallet(privateKey);
  const publicKey = wallet.address;
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
  privateKeyNotHashed: string;
}

/**
 * Computes the proxy address for a given phone number.
 *
 * @param {string} phoneNumber - The phone number to compute the proxy address for.
 * @returns {Promise<ComputedAddress>} A promise that resolves to an object containing the proxy address, EOA address, and private key.
 * @throws {Error} If there's an error in the computation process.
 */
export async function computeProxyAddressFromPhone(phoneNumber: string): Promise<ComputedAddress> {
  const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc, {
    name: networkConfig.name,
    chainId: networkConfig.chainId
  });

  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const chatterpayWalletFactoryABI = await getChatterPayWalletFactoryABI();
  const factory = ChatterPayWalletFactory__factory.connect(
    networkConfig.contracts.factoryAddress,
    chatterpayWalletFactoryABI,
    backendSigner
  );

  const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(
    phoneNumber,
    networkConfig.chainId.toString()
  );

  const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, {
    gasLimit: 1000000
  });
  Logger.log('computeProxyAddressFromPhone', `Computed proxy address: ${proxyAddress}`);

  const code = await provider.getCode(proxyAddress);
  if (code === '0x') {
    Logger.log(
      'computeProxyAddressFromPhone',
      `Creating new wallet for EOA: ${ownerAddress.publicKey}, will result in: ${proxyAddress}.`
    );
    const gasLimit = await gasService.getDynamicGas(
      factory,
      'createProxy',
      [ownerAddress.publicKey],
      20,
      BigNumber.from('700000')
    );
    const tx = await factory.createProxy(ownerAddress.publicKey, {
      gasLimit
    });
    await tx.wait();
  }

  Logger.log(
    'computeProxyAddressFromPhone',
    JSON.stringify({
      proxyAddress,
      EOAAddress: ownerAddress.publicKey
    })
  );

  return {
    proxyAddress,
    EOAAddress: ownerAddress.publicKey,
    privateKey: ownerAddress.hashedPrivateKey,
    privateKeyNotHashed: ownerAddress.privateKey
  };
}
