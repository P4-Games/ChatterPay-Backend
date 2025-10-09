import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { LeaderboardResult, chatterpointsService } from '../services/chatterpointsService';
import { ChatterPointsBusinessException } from '../exxceptions/domain/ChatterpointBusinessError';
import {
  GameType,
  WindowUnit,
  GameSection,
  GameSettings,
  WordleSettings,
  SocialPlatform,
  HangmanSettings,
  WordlePointsConfig,
  HangmanPointsConfig
} from '../models/chatterpointsModel';

// -------------------------------------------------------------------------------------------------------------
// Local, controller-only types (mínimos, sin repetir lo que ya existe en el modelo)
type IncludeKind = 'games' | 'operations' | 'social' | 'prizes';

interface CreateCycleBody {
  startAt?: string;
  endAt?: string;
  channel_user_id: string;
  durationMinutes?: number;
  podiumPrizes?: number[];
  games?: Array<{
    gameId: string;
    type: GameType;
    enabled?: boolean;
    config?: {
      settings?: {
        wordLength?: number;
        attemptsPerUserPerPeriod?: number;
        periodWindow?: { unit: WindowUnit; value: number };
      };
      points?: Record<string, number>;
    };
  }>;
}

interface PlayBody {
  cycleId: string;
  periodId: string;
  channel_user_id: string;
  gameId: string;
  guess: string;
}

interface StatsBody {
  cycleId: string | undefined;
  channel_user_id: string;
}

interface LeaderboardBody {
  cycleId: string;
  top?: number;
}

interface SocialBody {
  cycleId: string;
  channel_user_id: string;
  platform: SocialPlatform;
}

interface PlaysBody {
  cycleId?: string;
  channel_user_id?: string;
}

type DatePreset =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_365_days'
  | 'custom';

interface UserHistoryBody {
  channel_user_id: string;
  datePreset?: DatePreset;
  startAt?: string; // ISO (required if datePreset === 'custom')
  endAt?: string; // ISO (required if datePreset === 'custom')
  include?: IncludeKind[]; // default: all
  gameTypes?: GameType[]; // default: ['WORDLE','HANGMAN']
  platforms?: SocialPlatform[]; // default: all platforms
  gameIds?: string[]; // optional: filter by specific games (e.g., ['wordle','hangman'])
}

// -------------------------------------------------------------------------------------------------------------
// Helpers (solo controller)

function resolveDateRange(
  preset: DatePreset | undefined,
  startAt?: string,
  endAt?: string
): { from: Date; to: Date } {
  const now = new Date();

  const startOfDay = (d: Date): Date => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x;
  };
  const endOfDay = (d: Date): Date => {
    const x = new Date(d);
    x.setUTCHours(23, 59, 59, 999);
    return x;
  };

  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: endOfDay(now) };
    case 'yesterday': {
      const y = new Date(now);
      y.setUTCDate(now.getUTCDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case 'last_7_days': {
      const from = new Date(now);
      from.setUTCDate(now.getUTCDate() - 6);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case 'last_30_days': {
      const from = new Date(now);
      from.setUTCDate(now.getUTCDate() - 29);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case 'last_365_days': {
      const from = new Date(now);
      from.setUTCDate(now.getUTCDate() - 364);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
    case 'custom': {
      if (!startAt || !endAt) {
        throw new Error('Custom date range requires startAt and endAt.');
      }
      const from = new Date(startAt);
      const to = new Date(endAt);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new Error('Invalid custom date range.');
      }
      return { from, to };
    }
    default: {
      // Default: last 30 days
      const from = new Date(now);
      from.setUTCDate(now.getUTCDate() - 29);
      return { from: startOfDay(from), to: endOfDay(now) };
    }
  }
}

// -------------------------------------------------------------------------------------------------------------
// Handlers

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
    reply.status(200).send({ status: 'ok', cycleId: result.cycleId.toString() });
  } catch (err) {
    Logger.error('createCycle', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
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

    const result = await chatterpointsService.play({ userId: channel_user_id, gameId, guess });
    Logger.info('play', 'attempt accepted', { userId: channel_user_id, gameId });
    reply.status(200).send(result);
  } catch (err) {
    if (err instanceof ChatterPointsBusinessException) {
      Logger.info('play', err.message, { code: err.code });
      return reply.status(200).send({
        status: 'info',
        code: err.code,
        error: err.message
      });
    }

    Logger.error('play', (err as Error).message);
    reply.status(200).send({
      status: 'error',
      error: (err as Error).message
    });
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
    Logger.debug('stats', 'fetched', { cycleId, userId: channel_user_id });
    reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('stats', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
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
  } catch (err) {
    Logger.error('leaderboard', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
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

    // result: { granted: boolean }
    Logger.info('social', 'registered', {
      userId: channel_user_id,
      platform,
      granted: result.granted
    });

    reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('social', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const gamesInfo = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const result = await chatterpointsService.getCycleGamesInfo();
    Logger.debug('gamesInfo', 'returned games info');
    reply.status(200).send(result);
  } catch (err) {
    Logger.error('gamesInfo', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const clean = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const result = await chatterpointsService.maintainPeriodsAndCycles();
    Logger.info('clean', 'maintenance summary', result);
    reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('clean', (err as Error).message);
    reply.status(500).send({ status: 'error', error: (err as Error).message });
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
      reply.status(404).send({ status: 'error', error: 'No plays found' });
      return;
    }

    Logger.debug('cyclePlays', 'ok', { cycleId: result.cycleId, count: result.plays?.length ?? 0 });

    reply.status(200).send({
      status: 'ok',
      cycleId: result.cycleId,
      startAt: result.startAt,
      endAt: result.endAt,
      cycleStatus: result.status,
      plays: result.plays
    });
  } catch (err) {
    Logger.error('cyclePlays', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};

export const userHistory = async (
  req: FastifyRequest<{ Body: UserHistoryBody }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    // Body puede venir undefined, protegemos y tipamos
    type UB = Partial<UserHistoryBody>;
    const body: UB = (req.body ?? {}) as UB;

    const { channel_user_id, datePreset, startAt, endAt } = body;

    if (!channel_user_id) {
      Logger.warn('userHistory', 'missing channel_user_id');
      throw new Error('Missing required fields');
    }

    // Defaults MUTABLES (evitan el problema de readonly tuples)
    const include: IncludeKind[] =
      Array.isArray(body.include) && body.include.length > 0
        ? body.include.filter(
            (x): x is IncludeKind =>
              x === 'games' || x === 'operations' || x === 'social' || x === 'prizes'
          )
        : (['games', 'operations', 'social', 'prizes'] as IncludeKind[]);

    const gameTypes: GameType[] =
      Array.isArray(body.gameTypes) && body.gameTypes.length > 0
        ? body.gameTypes.filter((x): x is GameType => x === 'WORDLE' || x === 'HANGMAN')
        : (['WORDLE', 'HANGMAN'] as GameType[]);

    const platforms: SocialPlatform[] =
      Array.isArray(body.platforms) && body.platforms.length > 0
        ? body.platforms.filter(
            (x): x is SocialPlatform =>
              x === 'discord' ||
              x === 'youtube' ||
              x === 'x' ||
              x === 'instagram' ||
              x === 'linkedin'
          )
        : (['discord', 'youtube', 'x', 'instagram', 'linkedin'] as SocialPlatform[]);

    const gameIds =
      Array.isArray(body.gameIds) && body.gameIds.length > 0
        ? body.gameIds
            .filter((g): g is string => typeof g === 'string')
            .map((g) => g.trim())
            .filter((g) => g.length > 0)
        : undefined;

    const { from, to } = resolveDateRange(datePreset, startAt, endAt);

    // Llama SOLO al servicio de negocio
    const result = await chatterpointsService.getUserHistory({
      userId: channel_user_id,
      from,
      to,
      include,
      gameTypes,
      platforms,
      gameIds
    });

    Logger.debug('userHistory', 'ok', {
      userId: channel_user_id,
      include: result.include,
      window: { from, to }
    });

    reply.status(200).send({ status: 'ok', ...result });
  } catch (err) {
    Logger.error('userHistory', (err as Error).message);
    reply.status(200).send({ status: 'error', error: (err as Error).message });
  }
};
