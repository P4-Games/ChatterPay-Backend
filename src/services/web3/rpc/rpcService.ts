import { Logger } from '../../../helpers/loggerHelper';
import { rpcQueueAlchemy, rpcQueuePimlico } from './rpcQueue';
import { RpcProvider, rpcProviders } from '../../../types/commonType';

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
