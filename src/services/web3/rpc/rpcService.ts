import { BigNumber, ethers } from 'ethers';
import { Logger } from '../../../helpers/loggerHelper';
import type { IBlockchain } from '../../../models/blockchainModel';
import {
  type ComputedAddress,
  type RpcProvider,
  rpcProviders,
  type UserPrincipal
} from '../../../types/commonType';
import { ChatterPayWalletFactory__factory } from '../../../types/ethers-contracts/factories/ChatterPayWalletFactory__factory';
import { mongoBlockchainService } from '../../mongo/mongoBlockchainService';
import { secService } from '../../secService';
import { getChatterPayWalletFactoryABI } from '../abiService';
import { gasService } from '../gasService';
import { rpcQueueAlchemy, rpcQueuePimlico } from './rpcQueue';

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
 * @param {string} pn - The phone number to compute the proxy address for.
 * @returns {Promise<ComputedAddress>} A promise that resolves to an object containing the proxy address,
 * EOA address, and private key.
 * @throws {Error} If there's an error in the computation process.
 */
export async function computeWallet(pn: string): Promise<ComputedAddress> {
  try {
    const networkConfig: IBlockchain = await mongoBlockchainService.getNetworkConfig();
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc, {
      name: networkConfig.name,
      chainId: networkConfig.chainId
    });

    const bs = secService.get_bs(provider);
    const chatterpayWalletFactoryABI = await getChatterPayWalletFactoryABI();
    const factory = ChatterPayWalletFactory__factory.connect(
      networkConfig.contracts.factoryAddress,
      chatterpayWalletFactoryABI,
      bs
    );

    const userPrincipal: UserPrincipal = secService.get_us(pn, networkConfig.chainId.toString());

    const proxyAddress = await factory.computeProxyAddress(userPrincipal.EOAAddress, {
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
              `Creating new wallet for EOA: ${userPrincipal.EOAAddress}, will result in: ${proxyAddress}.`
            );
            const gasLimit = await gasService.getDynamicGas(
              factory,
              'createProxy',
              [userPrincipal.EOAAddress],
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

            const tx = await factory.createProxy(userPrincipal.EOAAddress, {
              gasLimit,
              gasPrice
            });
            Logger.log('computeWallet', `tx: ${tx.hash}`);
            return tx.wait().then(() => true);
          },
          name: 'createProxy',
          args: [userPrincipal.EOAAddress]
        },
        rpcProviders.ALCHEMY
      );
    }

    Logger.log(
      'computeWallet',
      JSON.stringify({
        proxyAddress,
        EOAAddress: userPrincipal.EOAAddress
      })
    );

    return {
      proxyAddress,
      EOAAddress: userPrincipal.EOAAddress,
      data: userPrincipal.data
    };
  } catch (error) {
    Logger.error('computeWallet', error);
    throw error;
  }
}
