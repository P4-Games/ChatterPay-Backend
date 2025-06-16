import PQueue from 'p-queue';

import { QUEUE_BUNDLER_INTERVAL, QUEUE_CREATE_PROXY_INTERVAL } from '../../../config/constants';

/**
 * Alchemy provider queue (used for createProxy)
 * Free-tier allows ~10 requests per second.
 * To stay 25% under the limit, we target 7.5 RPS ⇒ 1 request every ~133ms.
 */
export const rpcQueueAlchemy = new PQueue({
  concurrency: 1,
  interval: QUEUE_CREATE_PROXY_INTERVAL,
  intervalCap: 1
});

/**
 * Pimlico provider queue (used for bundler ops)
 * Free-tier allows 500 requests per minute ⇒ ~8.33 RPS.
 * To stay 25% under the limit, we target 6.25 RPS ⇒ 1 request every ~160ms.
 */
export const rpcQueuePimlico = new PQueue({
  concurrency: 1,
  interval: QUEUE_BUNDLER_INTERVAL,
  intervalCap: 1
});
