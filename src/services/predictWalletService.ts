import { ethers } from 'ethers';
import * as crypto from 'crypto';

import { Logger } from '../helpers/loggerHelper';
import { SIGNING_KEY } from '../config/constants';
import { IBlockchain } from '../models/blockchain';
import { getNetworkConfig } from './networkService';
import { getDynamicGas } from '../helpers/paymasterHelper';
import { generatePrivateKey } from '../helpers/SecurityHelper';
import { getChatterPayWalletFactoryABI } from './bucketService';
import { getPhoneNumberFormatted } from '../helpers/formatHelper';
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
  const privateKey = generatePrivateKey(getPhoneNumberFormatted(phoneNumber));
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
  const networkConfig: IBlockchain = await getNetworkConfig();
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc, {
    name: 'arbitrum-sepolia',
    chainId: networkConfig.chain_id
  });

  const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
  const chatterpayWalletFactoryABI = await getChatterPayWalletFactoryABI();
  const factory = ChatterPayWalletFactory__factory.connect(
    networkConfig.contracts.factoryAddress,
    chatterpayWalletFactoryABI,
    backendSigner
  );

  const ownerAddress: PhoneNumberToAddress = phoneNumberToAddress(phoneNumber);

  const proxyAddress = await factory.computeProxyAddress(ownerAddress.publicKey, {
    gasLimit: 1000000
  });
  Logger.log('computeProxyAddressFromPhone', `Computed proxy address: ${proxyAddress}`);

  const code = await provider.getCode(proxyAddress);
  if (code === '0x') {
    Logger.log(
      'computeProxyAddressFromPhone',
      `Creating new wallet for EOA: ${ownerAddress.publicKey}, will result in: ${proxyAddress}...`
    );
    const gasLimit = await getDynamicGas(factory, 'createProxy', [ownerAddress.publicKey]);
    const tx = await factory.createProxy(ownerAddress.publicKey, {
      gasLimit
    });
    await tx.wait();
  }

  Logger.log(
    'computeProxyAddressFromPhone',
    'Data: ',
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
