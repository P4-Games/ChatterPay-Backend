import { FastifyReply, FastifyRequest } from 'fastify';
import { processStakeRequest } from '../services/stakeService';
import { Logger } from '../helpers/loggerHelper';
import { DEFAULT_CHAIN_ID } from '../config/constants';

interface StakeBody {
  amount: string;
  chain_id?: number;
  token?: string;
}

export const stakeHandler = async (
  request: FastifyRequest<{ Body: StakeBody }>,
  reply: FastifyReply
) => {
  const { amount, chain_id = DEFAULT_CHAIN_ID, token = 'USX' } = request.body;
  // @ts-ignore
  const { channel_user_id } = request.user;
  const LOG_KEY = `stake-${token}-${channel_user_id}-${Date.now()}`;

  Logger.info('stakeHandler', LOG_KEY, `Processing stake request for ${amount} ${token}`);

  const result = await processStakeRequest(channel_user_id, amount, chain_id, 'stake', token, LOG_KEY);

  if (result.result) {
    return reply.code(200).send(result);
  } else {
    return reply.code(400).send(result);
  }
};

export const unstakeHandler = async (
  request: FastifyRequest<{ Body: StakeBody }>,
  reply: FastifyReply
) => {
  const { amount, chain_id = DEFAULT_CHAIN_ID, token = 'USX' } = request.body;
  // @ts-ignore
  const { channel_user_id } = request.user;
  const LOG_KEY = `unstake-${token}-${channel_user_id}-${Date.now()}`;

  Logger.info('unstakeHandler', LOG_KEY, `Processing unstake request for ${amount} ${token}`);

  const result = await processStakeRequest(channel_user_id, amount, chain_id, 'unstake', token, LOG_KEY);

  if (result.result) {
    return reply.code(200).send(result);
  } else {
    return reply.code(400).send(result);
  }
};
