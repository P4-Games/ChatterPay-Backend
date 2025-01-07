import { FastifyInstance } from 'fastify';

import { Logger } from '../helpers/logger';
import { getEntryPointABI } from '../services/bucketService';
import { sendTransferNotification } from '../services/notificationService';

/**
 * Registers the ping route with the Fastify instance.
 * @param {FastifyInstance} fastify - The Fastify instance
 * @returns {Promise<void>}
 */
export const pingRoute = async (fastify: FastifyInstance): Promise<void> => {
  /**
   * Route to check server status
   * @route GET /ping
   */
  fastify.get('/ping', () => {
    Logger.log('test', 'xxx', 'zzzz');
    return { status: 'ok', message: 'pong' };
  });

  const testFunction = async (): Promise<unknown> => {
    /*
        const x1 = await sendSwapNotification('0x35dad65F60c1A32c9895BE97f6bcE57D32792E83', '5491153475204', 'asd', '123', '567', 'USDT', '0x33' )
        const x2 = await sendOutgoingTransferNotification('0x35dad65F60c1A32c9895BE97f6bcE57D32792E83', '5491153475204', 'asd', '123', 'USDT', '0x')
        const x3 = await sendMintNotification('0x35dad65F60c1A32c9895BE97f6bcE57D32792E83', '5491153475204', '123')
        const x4 = await sendTransferNotification('0x35dad65F60c1A32c9895BE97f6bcE57D32792E83', '5491153475204', '0x2', '123', 'USDT')
        return { x1, x2, x3, x4 };
        */
    const x4 = await sendTransferNotification(
      '0x35dad65F60c1A32c9895BE97f6bcE57D32792E83',
      '5491153475204',
      '0x2',
      '123',
      'USDT'
    );

    const entrypointABI = await getEntryPointABI();
    Logger.log('new entrepoint abi', entrypointABI);

    return { old: true, new: entrypointABI, x4 };
  };

  fastify.get('/test', async () => {
    const result = await testFunction();
    return { status: 'ok', message: result };
  });
};
