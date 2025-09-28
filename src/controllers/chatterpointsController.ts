import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { LeaderboardResult, chatterpointsService } from '../services/chatterpointsService';
import {
  GameSection,
  GameSettings,
  WordleSettings,
  HangmanSettings,
  WordlePointsConfig,
  HangmanPointsConfig
} from '../models/chatterpointsModel';

export interface CreateCycleBody {
  startAt?: string;
  endAt?: string;
  channel_user_id: string;
  durationMinutes?: number;
  podiumPrizes?: number[];
  games?: Array<{
    gameId: string;
    type: 'WORDLE' | 'HANGMAN';
    enabled?: boolean;
    config?: {
      settings?: {
        wordLength?: number;
        attemptsPerUserPerPeriod?: number;
        periodWindow?: { unit: 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS'; value: number };
      };
      points?: Record<string, number>;
    };
  }>;
}

export interface PlayBody {
  cycleId: string;
  periodId: string;
  channel_user_id: string;
  gameId: string;
  guess: string;
}

export interface StatsBody {
  cycleId: string | undefined;
  channel_user_id: string;
}

export interface LeaderboardBody {
  cycleId: string;
  top?: number;
}

export interface SocialBody {
  cycleId: string;
  channel_user_id: string;
  platform: 'discord' | 'youtube' | 'x' | 'instagram' | 'linkedin';
}

export interface PlaysBody {
  cycleId?: string;
  channel_user_id?: string;
}

export const createCycle = async (
  req: FastifyRequest<{ Body: CreateCycleBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    const { channel_user_id, startAt, endAt, durationMinutes, podiumPrizes, games } = req.body;

    Logger.info('createCycle', {
      userId: channel_user_id,
      startAt,
      endAt,
      durationMinutes,
      hasGames: Array.isArray(games)
    });

    const result = await chatterpointsService.createCycle({
      userId: channel_user_id,
      startAt: startAt ? new Date(startAt) : undefined,
      endAt: endAt ? new Date(endAt) : undefined,
      durationMinutes,
      podiumPrizes: podiumPrizes ?? [0, 0, 0],
      games: games?.map((g): Partial<GameSection> & Pick<GameSection, 'type' | 'gameId'> => ({
        gameId: g.gameId,
        type: g.type,
        enabled: g.enabled,
        config: g.config
          ? ((g.type === 'WORDLE'
              ? {
                  type: 'WORDLE',
                  settings: g.config.settings as WordleSettings,
                  points: g.config.points as unknown as WordlePointsConfig
                }
              : {
                  type: 'HANGMAN',
                  settings: g.config.settings as HangmanSettings,
                  points: g.config.points as unknown as HangmanPointsConfig
                }) satisfies GameSettings)
          : undefined
      }))
    });

    Logger.info('createCycle', 'cycle created', { cycleId: result.cycleId });
    await reply.status(200).send({ status: 'ok', cycleId: result.cycleId.toString() });
  } catch (err) {
    Logger.error('createCycle', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const play = async (
  req: FastifyRequest<{ Body: PlayBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    const { channel_user_id, gameId, guess } = req.body;

    if (!channel_user_id || !gameId || !guess) {
      Logger.warn('play', 'missing required fields', {
        channel_user_id,
        gameId,
        guessLen: guess?.length
      });
      throw new Error('Missing required fields');
    }

    if (gameId.toUpperCase() === 'HANGMAN') {
      const isLetterGuess = guess.length === 1;
      const isWordGuess = guess.length >= 2; // service validates exact word length
      if (!isLetterGuess && !isWordGuess) {
        Logger.warn('play', 'invalid hangman guess shape', { guess });
        throw new Error('Hangman guess must be a single letter or a full word.');
      }
    }

    if (!/^[A-Za-z]+$/.test(guess)) {
      Logger.warn('play', 'guess contains non-letters', { guess });
      throw new Error('Guess must contain only letters (A-Z).');
    }

    const result = await chatterpointsService.play({ userId: channel_user_id, gameId, guess });
    Logger.info('play', 'attempt accepted', { userId: channel_user_id, gameId });
    await reply.status(200).send(result);
  } catch (err) {
    Logger.error('play', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const stats = async (
  req: FastifyRequest<{ Body: StatsBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    const { cycleId, channel_user_id } = req.body;
    if (!channel_user_id) {
      Logger.warn('stats', 'missing channel_user_id');
      throw new Error('Missing required fields');
    }
    const result = await chatterpointsService.getStats({ cycleId, userId: channel_user_id });
    Logger.debug('stats', 'fetched', { cycleId: result.cycle?.cycleId, userId: channel_user_id });
    await reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('stats', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const leaderboard = async (
  req: FastifyRequest<{ Body: LeaderboardBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    const { cycleId, top } = req.body;
    const result: LeaderboardResult = await chatterpointsService.getLeaderboard({ cycleId, top });
    const sanitizedEntries = result.entries.map(({ prize: _prize, ...rest }) => rest);
    Logger.debug('leaderboard', { cycleId, top, count: sanitizedEntries.length });
    await reply.status(200).send({ status: 'ok', leaderboard: sanitizedEntries });
  } catch (err) {
    Logger.error('leaderboard', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const social = async (
  req: FastifyRequest<{ Body: SocialBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    const { cycleId, channel_user_id, platform } = req.body;
    if (!channel_user_id || !platform) {
      Logger.warn('social', 'missing required fields', { channel_user_id, platform });
      throw new Error('Missing required fields');
    }
    const result = await chatterpointsService.registerSocial({
      cycleId,
      userId: channel_user_id,
      platform
    });
    Logger.info('social', 'registered', {
      userId: channel_user_id,
      platform,
      inserted: result.inserted
    });
    await reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('social', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const gamesInfo = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const result = await chatterpointsService.getCycleGamesInfo();
    Logger.debug('gamesInfo', 'returned games info');
    await reply.status(200).send(result);
  } catch (err) {
    Logger.error('gamesInfo', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const clean = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const result = await chatterpointsService.maintainPeriodsAndCycles();
    Logger.info('clean', 'maintenance summary', result);
    await reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('clean', (err as Error).message);
    await reply.status(500).send({ status: 'error', error: (err as Error).message });
  }
};

export const cyclePlays = async (
  req: FastifyRequest<{ Body: PlaysBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const { cycleId, channel_user_id } = body as Partial<PlaysBody>;

    const result = await chatterpointsService.getCyclePlays({
      cycleId,
      userId: channel_user_id
    });

    if (!result) {
      Logger.debug('cyclePlays', 'no plays found', { cycleId, userId: channel_user_id });
      await reply.status(404).send({ status: 'error', error: 'No plays found' });
      return;
    }

    Logger.debug('cyclePlays', 'ok', { cycleId: result.cycleId, count: result.plays?.length ?? 0 });

    await reply.status(200).send({
      status: 'ok',
      cycleId: result.cycleId,
      startAt: result.startAt,
      endAt: result.endAt,
      cycleStatus: result.status,
      plays: result.plays
    });
  } catch (err) {
    Logger.error('cyclePlays', (err as Error).message);
    await reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};
