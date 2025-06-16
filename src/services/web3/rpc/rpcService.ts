import * as crypto from 'crypto';
import { ethers, BigNumber } from 'ethers';

import { gasService } from '../gasService';
import { Logger } from '../../../helpers/loggerHelper';
import { SIGNING_KEY } from '../../../config/constants';
import { rpcQueueAlchemy, rpcQueuePimlico } from './rpcQueue';
import { IBlockchain } from '../../../models/blockchainModel';
import { getChatterPayWalletFactoryABI } from '../abiService';
import { generateWalletSeed } from '../../../helpers/SecurityHelper';
import { getPhoneNumberFormatted } from '../../../helpers/formatHelper';
import { mongoBlockchainService } from '../../mongo/mongoBlockchainService';
import {
  RpcProvider,
  rpcProviders,
  ComputedAddress,
  PhoneNumberToAddress
} from '../../../types/commonType';
import { ChatterPayWalletFactory__factory } from '../../../types/ethers-contracts/factories/ChatterPayWalletFactory__factory';

type Serializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Serializable[]
  | { [key: string]: Serializable };

type RpcCallWrapper<T> = {
  fn: () => Promise<T>;
  name?: string;
  args?: Serializable[];
};

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
  const privateKey = generateWalletSeed(getPhoneNumberFormatted(phoneNumber), chainId);
  const wallet = new ethers.Wallet(privateKey);
  const publicKey = wallet.address;
  const hashedPrivateKey = crypto.createHash('sha256').update(privateKey).digest('hex');

  return {
    hashedPrivateKey,
    privateKey,
    publicKey
  };
}

/**
 * Executes an asynchronous RPC function using a rate-limited queue specific to the selected provider.
 *
 * This wrapper ensures that calls to Alchemy or Pimlico respect their respective rate limits
 * by enqueuing them into the correct PQueue instance. It allows the function to return either
 * a value or void. This is useful for operations like sending transactions or fire-and-forget calls.
 *
 * ⚠️ Important: The function passed as `fn` must be a **function reference** (e.g., `() => ...`),
 * NOT the result of an already-invoked async expression. This ensures the logic is queued properly.
 *
 * @template T - The expected return type of the function.
 * @param fn - The asynchronous function to be executed. It must return a Promise of type T or void.
 * @param queueType - The RPC provider queue to use ('alchemy' or 'pimlico').
 * @returns A Promise resolving to the result of the function, or undefined if the function returns void.
 * @throws Will throw an error if the queue type is unknown.
 */
export async function wrapRpc<T>(
  { fn, name, args = [] }: RpcCallWrapper<T>,
  queueType: RpcProvider
): Promise<NonNullable<T>> {
  let queueName: string;
  let queue;

  if (queueType === rpcProviders.ALCHEMY) {
    queue = rpcQueueAlchemy;
    queueName = rpcProviders.ALCHEMY.toString();
  } else if (queueType === rpcProviders.PIMLICO) {
    queue = rpcQueuePimlico;
    queueName = rpcProviders.PIMLICO.toString();
  } else {
    throw new Error(`Unknown queue type: ${queueType}`);
  }

  const positionInQueue = queue.pending + 1;
  const fnName = name || fn.name || '<anonymous>';
  const argsStr = args.map((a) => JSON.stringify(a)).join(', ');

  Logger.log(
    'wrapRpc',
    `Queue: ${queueName} | Pos: ${positionInQueue} | Fn: ${fnName}(${argsStr})`
  );

  const result = await queue.add(fn);

  if (result === undefined || result === null) {
    throw new Error('wrapRpc expected a value but got void/null.');
  }

  return result;
}

/**
 * Computes the Wallet for a given phone number.
 *
 * @param {string} phoneNumber - The phone number to compute the proxy address for.
 * @returns {Promise<ComputedAddress>} A promise that resolves to an object containing the proxy address,
 * EOA address, and private key.
 * @throws {Error} If there's an error in the computation process.
 */
export async function computeWallet(phoneNumber: string): Promise<ComputedAddress> {
  try {
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
    Logger.log('computeWallet', `Computed proxy address: ${proxyAddress}`);

    const code = await provider.getCode(proxyAddress);
    if (code === '0x') {
      await wrapRpc(
        {
          fn: async () => {
            Logger.log(
              'computeWallet',
              `Creating new wallet for EOA: ${ownerAddress.publicKey}, will result in: ${proxyAddress}.`
            );
            const gasLimit = await gasService.getDynamicGas(
              factory,
              'createProxy',
              [ownerAddress.publicKey],
              20,
              BigNumber.from('700000')
            );

            let gasPrice: ethers.BigNumber;
            try {
              gasPrice = await provider.getGasPrice();
            } catch (error) {
              Logger.warn(
                'computeWallet',
                'Fallback gas price used due to getGasPrice() failure:',
                error
              );
              gasPrice = ethers.utils.parseUnits('5', 'gwei');
            }

            const tx = await factory.createProxy(ownerAddress.publicKey, {
              gasLimit,
              gasPrice
            });
            Logger.log('computeWallet', `tx: ${tx.hash}`);
            return tx.wait().then(() => true);
          },
          name: 'createProxy',
          args: [ownerAddress.publicKey]
        },
        rpcProviders.ALCHEMY
      );
    }

    Logger.log(
      'computeWallet',
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
  } catch (error) {
    Logger.error('computeWallet', error);
    throw error;
  }
}
