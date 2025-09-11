import crypto from 'crypto';

import { Logger } from '../helpers/loggerHelper';
import { getDisplayUserLabel } from './userService';
import { mongoUserService } from './mongo/mongoUserService';
import { mongoChatterpointsService } from './mongo/mongoChatterpointsService';
import {
  GameType,
  GameConfig,
  GamePeriod,
  TimeWindow,
  PeriodStatus,
  GameSettings,
  IChatterpointsDocument
} from '../models/chatterpointsModel';

/**
 * Business logic layer for Chatterpoints.
 * - Validates constraints (one open cycle, periods < cycle, attempts per period, etc.)
 * - Generates words and periods
 * - Applies scoring
 */

export interface CreateCycleRequest {
  userId: string;
  startAt?: Date;
  /** Duration in minutes for convenience */
  durationMinutes?: number;
  /** Explicit endAt (ignored if durationMinutes provided) */
  endAt?: Date;
  /** Games to enable with optional overrides; defaults applied if omitted */
  games?: Array<Partial<GameConfig> & Pick<GameConfig, 'type' | 'gameId'>>;
  podiumPrizes?: number[];
}

export interface PlayRequest {
  userId: string;
  gameId: string;
  guess: string;
}

export interface SocialRequest {
  cycleId: string | undefined;
  userId: string;
  platform: 'discord' | 'youtube' | 'x' | 'instagram' | 'linkedin';
}

export interface StatsRequest {
  cycleId: string | undefined;
  userId: string;
}

export interface LeaderboardRequest {
  cycleId: string | undefined;
  top?: number;
}

const DEFAULTS = {
  cycleDurationMinutes: 7 * 24 * 60, // weekly
  wordle: {
    wordLength: 7,
    attemptsPerUserPerPeriod: 6,
    periodWindow: { unit: 'DAYS', value: 1 } as TimeWindow,
    points: { victoryBase: 50, letterExact: 5, letterPresent: 2 }
  },
  hangman: {
    wordLength: 7,
    periodWindow: { unit: 'DAYS', value: 1 } as TimeWindow,
    points: { victoryBase: 50, losePenalty: 0, maxWrongAttempts: 6 }
  }
} as const;

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function windowToMinutes(w: TimeWindow): number {
  switch (w.unit) {
    case 'MINUTES':
      return w.value;
    case 'HOURS':
      return w.value * 60;
    case 'DAYS':
      return w.value * 60 * 24;
    case 'WEEKS':
      return w.value * 60 * 24 * 7;
    default:
      return w.value;
  }
}

function randomWord(len: number, disallow: Set<string>): string {
  // Simple deterministic pseudo-random word generator (letters a-z)
  // Ensures uniqueness within the provided disallow set.
  let attempt = '';
  for (let i = 0; i < 5000; i += 1) {
    const buf = crypto.randomBytes(len);
    attempt = Array.from(buf)
      .map((b) => String.fromCharCode(97 + (b % 26)))
      .join('');
    if (!disallow.has(attempt)) return attempt;
  }
  // If uniqueness is too hard, append a suffix
  let suffix = 0;
  while (disallow.has(`${attempt}${suffix}`)) suffix += 1;
  return `${attempt}${suffix}`;
}

function expandPeriodsForGame(game: GameConfig, startAt: Date, endAt: Date): GamePeriod[] {
  const periods: GamePeriod[] = [];
  const minutes = windowToMinutes(game.config.settings.periodWindow as TimeWindow);
  const disallow = new Set<string>(game.usedWords);
  let idx = 0;
  let cursor = new Date(startAt);
  while (cursor < endAt) {
    const next = addMinutes(cursor, minutes);
    if (next > endAt) break;
    periods.push({
      periodId: `p${idx}`,
      gameId: game.gameId,
      index: idx,
      word: randomWord(
        (game.config.settings as unknown as { wordLength?: number }).wordLength ?? 7,
        disallow
      ),
      startAt: new Date(cursor),
      endAt: new Date(next),
      status: 'OPEN' as PeriodStatus,
      plays: []
    });
    idx += 1;
    cursor = next;
  }
  return periods;
}
function defaultGameConfig(type: GameType, gameId: string): GameConfig {
  if (type === 'WORDLE') {
    return {
      gameId,
      type: 'WORDLE',
      enabled: true,
      config: {
        type: 'WORDLE',
        settings: {
          wordLength: DEFAULTS.wordle.wordLength,
          attemptsPerUserPerPeriod: DEFAULTS.wordle.attemptsPerUserPerPeriod,
          periodWindow: DEFAULTS.wordle.periodWindow
        },
        points: DEFAULTS.wordle.points
      },
      usedWords: []
    };
  }
  return {
    gameId,
    type: 'HANGMAN',
    enabled: true,
    config: {
      type: 'HANGMAN',
      settings: {
        wordLength: DEFAULTS.hangman.wordLength,
        periodWindow: DEFAULTS.hangman.periodWindow
      },
      points: DEFAULTS.hangman.points
    },
    usedWords: []
  };
}

function validatePeriodHierarchy(cycleMinutes: number, periodMinutes: number): void {
  if (periodMinutes >= cycleMinutes) {
    throw new Error('Game period must be strictly shorter than cycle duration');
  }
}

export const chatterpointsService = {
  createCycle: async (req: CreateCycleRequest): Promise<IChatterpointsDocument> => {
    if (!req.userId) {
      throw new Error("You don't have access to this operation.");
    }

    const isAdmin = await mongoUserService.getUser(req.userId);
    if (!isAdmin?.games_admin || false) {
      throw new Error("You don't have access to this operation.");
    }

    const existing = await mongoChatterpointsService.getOpenCycle();
    if (existing) {
      // Auto-close if expired
      if (new Date(existing.endAt).getTime() <= Date.now()) {
        await mongoChatterpointsService.closeCycleById(existing.cycleId);
      } else {
        throw new Error('There is an already OPEN cycle');
      }
    }

    const startAt = req.startAt ?? new Date();
    const endAt = req.durationMinutes
      ? addMinutes(startAt, req.durationMinutes)
      : (req.endAt ?? addMinutes(startAt, DEFAULTS.cycleDurationMinutes));

    const gamesRequested = req.games ?? [
      { type: 'WORDLE' as GameType, gameId: 'wordle' },
      { type: 'HANGMAN' as GameType, gameId: 'hangman' }
    ];

    // Build game configs with defaults + overrides
    const games: GameConfig[] = gamesRequested.map((g) => {
      const base = defaultGameConfig(g.type, g.gameId);
      const merged: GameConfig = {
        ...base,
        enabled: (g as { enabled?: boolean }).enabled ?? base.enabled,
        config: {
          ...base.config,
          settings: {
            ...(base.config as unknown as { settings: Record<string, unknown> }).settings,
            ...((g as { config?: { settings?: Record<string, unknown> } }).config?.settings ?? {})
          },
          points: {
            ...(base.config as unknown as { points: Record<string, number> }).points,
            ...((g as { config?: { points?: Record<string, number> } }).config?.points ?? {})
          }
        } as unknown as typeof base.config
      };
      return merged;
    });

    // Validate hierarchy
    const cycleMinutes = Math.ceil((endAt.getTime() - startAt.getTime()) / 60000);
    games.forEach((g) => {
      const pMin = windowToMinutes(
        (g.config as unknown as { settings: { periodWindow: TimeWindow } }).settings.periodWindow
      );
      validatePeriodHierarchy(cycleMinutes, pMin);
    });

    // Expand periods for each enabled game
    const allPeriods: GamePeriod[] = [];
    games
      .filter((g) => g.enabled)
      .forEach((g) => {
        const ps = expandPeriodsForGame(g, startAt, endAt);
        allPeriods.push(...ps);
        // Track used words in the config to prevent reuse across cycles (basic)
        g.usedWords.push(...ps.map((p) => p.word));
      });

    return mongoChatterpointsService.createCycle({
      startAt,
      endAt,
      games,
      periods: allPeriods,
      podiumPrizes: req.podiumPrizes ?? [0, 0, 0]
    });
  },

  play: async (
    req: PlayRequest
  ): Promise<{
    status: string;
    periodClosed: boolean;
    won: boolean;
    points: number;
    display_info?: Record<string, unknown>;
  }> => {
    Logger.debug('[play] start userId=%s gameId=%s guess=%s', req.userId, req.gameId, req.guess);

    const cycle = await mongoChatterpointsService.getOpenCycle();
    if (!cycle || cycle.status !== 'OPEN') throw new Error('Cycle not found or not OPEN');

    const { cycleId } = cycle;
    Logger.debug(
      '[play] cycle found cycleId=%s status=%s startAt=%s endAt=%s',
      cycleId,
      cycle.status,
      new Date(cycle.startAt).toISOString(),
      new Date(cycle.endAt).toISOString()
    );

    // 2) Active period handling
    const now = new Date();
    const nowTs = now.getTime();

    const candidates = cycle.periods.filter((p) => p.gameId === req.gameId);
    Logger.debug(
      '[play] periods candidates for game=%s count=%d now=%s',
      req.gameId,
      candidates.length,
      now.toISOString()
    );

    // 🔒 Close expired periods
    const expired = candidates.filter(
      (p) => p.status === 'OPEN' && new Date(p.endAt).getTime() <= nowTs
    );
    if (expired.length > 0) {
      Logger.debug(
        '[play] closing %d expired periods for game=%s: %s',
        expired.length,
        req.gameId,
        expired.map((p) => p.periodId).join(', ')
      );
      await Promise.all(
        expired.map((p) => mongoChatterpointsService.closePeriod(cycleId, p.periodId))
      );
    }

    // Re-fetch cycle after closing expired periods
    const refreshed = await mongoChatterpointsService.getCycleById(cycleId);
    if (!refreshed) throw new Error('Cycle disappeared unexpectedly');

    // Select active period
    const period = refreshed.periods.find(
      (p) =>
        p.gameId === req.gameId &&
        p.status === 'OPEN' &&
        new Date(p.startAt).getTime() <= nowTs &&
        nowTs < new Date(p.endAt).getTime()
    );

    if (!period) {
      Logger.debug('[play] no active period found for game=%s', req.gameId);
      return {
        status: 'ok',
        periodClosed: true,
        won: false,
        points: 0,
        display_info: { message: 'The current period has already concluded.' }
      };
    }

    const { periodId } = period;
    Logger.debug(
      '[play] active period periodId=%s startAt=%s endAt=%s status=%s',
      periodId,
      new Date(period.startAt).toISOString(),
      new Date(period.endAt).toISOString(),
      period.status
    );

    // 3) Guard if period just expired
    if (new Date(period.endAt).getTime() <= nowTs || period.status !== 'OPEN') {
      Logger.debug('[play] period not open anymore -> closing periodId=%s', periodId);
      await mongoChatterpointsService.closePeriod(cycleId, periodId);
      return {
        status: 'ok',
        periodClosed: true,
        won: false,
        points: 0,
        display_info: undefined
      };
    }

    // 4) Game config
    const gameCfg = refreshed.games.find((g) => g.gameId === req.gameId && g.enabled);
    if (!gameCfg) {
      Logger.debug('[play] game not configured or disabled gameId=%s', req.gameId);
      throw new Error('Game disabled or not configured');
    }
    Logger.debug('[play] gameCfg type=%s enabled=%s', gameCfg.type, gameCfg.enabled);

    const user = period.plays.find((u) => u.userId === req.userId);
    Logger.debug('[play] user state attempts=%s won=%s', user?.attempts ?? 0, user?.won ?? false);

    // 5) Rules
    if (gameCfg.type === 'WORDLE') {
      const wordleCfg = gameCfg.config as Extract<GameSettings, { type: 'WORDLE' }>;
      const maxAttempts = wordleCfg.settings.attemptsPerUserPerPeriod;
      const attempts = user?.attempts ?? 0;
      if (attempts >= maxAttempts) {
        return {
          status: 'ok',
          periodClosed: false,
          won: false,
          points: 0,
          display_info: { message: 'Max attempts reached for this period.' }
        };
      }
    } else if (gameCfg.type === 'HANGMAN') {
      if (user && (user.won || user.attempts > 0)) {
        return {
          status: 'ok',
          periodClosed: false,
          won: false,
          points: 0,
          display_info: { message: 'Already played this period.' }
        };
      }
    }

    // 6) Scoring
    let won = false;
    let points = 0;
    let displayInfo: Record<string, unknown> | undefined;

    if (gameCfg.type === 'WORDLE') {
      const answer = period.word;
      const guess = req.guess.toLowerCase();
      const wordleCfg = gameCfg.config as Extract<GameSettings, { type: 'WORDLE' }>;
      const wordLen = wordleCfg.settings.wordLength;

      if (guess.length !== wordLen) {
        throw new Error('Invalid guess length');
      }

      const answerArr = answer.split('');
      const guessArr = guess.split('');
      let result = '';
      const used: Record<string, number> = {};

      // Exact matches
      for (let i = 0; i < guessArr.length; i += 1) {
        if (guessArr[i] === answerArr[i]) {
          points += wordleCfg.points.letterExact;
          result += 'G';
          used[guessArr[i]] = (used[guessArr[i]] ?? 0) + 1;
        } else {
          result += '_';
        }
      }

      // Present but wrong position
      for (let i = 0; i < guessArr.length; i += 1) {
        if (result[i] !== 'G') {
          const ch = guessArr[i];
          const countInAnswer = answerArr.filter((c) => c === ch).length;
          const usedSoFar = used[ch] ?? 0;
          if (countInAnswer > usedSoFar) {
            points += wordleCfg.points.letterPresent;
            result = `${result.substring(0, i)}Y${result.substring(i + 1)}`;
            used[ch] = usedSoFar + 1;
          }
        }
      }

      if (guess === answer) {
        points += wordleCfg.points.victoryBase;
        won = true;
      }

      const prettyResult = result.replace(/G/g, '🟩').replace(/Y/g, '🟨').replace(/_/g, '⬜');

      displayInfo = {
        guess: `${guess} → ${prettyResult}`,
        attempts: `${(user?.attempts ?? 0) + 1}/${wordleCfg.settings.attemptsPerUserPerPeriod}`,
        partialPoints: points,
        message: won ? 'You won!' : 'Keep trying.'
      };

      await mongoChatterpointsService.pushPlayEntry(cycleId, periodId, req.userId, {
        guess,
        points,
        result,
        at: now,
        won,
        displayInfo
      });
    } else {
      // HANGMAN
      const answer = period.word;
      const guess = req.guess.toLowerCase();
      const hangmanCfg = gameCfg.config as Extract<GameSettings, { type: 'HANGMAN' }>;
      const wordLen = hangmanCfg.settings.wordLength;

      if (guess.length !== wordLen) {
        throw new Error('Invalid guess length');
      }

      if (guess === answer) {
        won = true;
        points = hangmanCfg.points.victoryBase;
      } else {
        points = hangmanCfg.points.losePenalty;
      }

      const currentWordProgress = guess
        .split('')
        .map((ch, i) => (ch === answer[i] ? ch.toUpperCase() : '_'))
        .join(' ');

      displayInfo = {
        wordProgress: currentWordProgress,
        guessedLetters: guess.toUpperCase().split(''),
        wrongLetters: won ? [] : guess.toUpperCase().split(''),
        remainingAttempts: hangmanCfg.points.maxWrongAttempts - 1
      };

      await mongoChatterpointsService.pushPlayEntry(cycleId, periodId, req.userId, {
        guess,
        points,
        at: now,
        won,
        displayInfo
      });
    }

    return { status: 'ok', periodClosed: false, won, points, display_info: displayInfo };
  },

  registerSocial: async (req: SocialRequest): Promise<{ granted: boolean }> => {
    // Resolve to the last OPEN cycle (social points require an OPEN cycle)
    let { cycleId } = req;
    let cycle = null as IChatterpointsDocument | null;

    if (cycleId) {
      cycle = await mongoChatterpointsService.getCycleById(cycleId);
      if (!cycle || cycle.status !== 'OPEN') throw new Error('No OPEN cycle found');
    } else {
      cycle = await mongoChatterpointsService.getOpenCycle();
      if (!cycle) throw new Error('No OPEN cycle found');
      ({ cycleId } = cycle); // destructuring assignment
    }

    const granted = await mongoChatterpointsService.addSocialRegistration(cycleId, {
      userId: req.userId,
      platform: req.platform,
      at: new Date()
    });

    return { granted };
  },

  getStats: async (
    req: StatsRequest
  ): Promise<{
    userId: string;
    userProfile: string;
    cycleId: string;
    totalPoints: number;
    periodsPlayed: number;
    wins: number;
  }> => {
    // Resolve cycleId (optional) → last cycle, open or closed
    let { cycleId } = req;
    if (!cycleId) {
      const last = await mongoChatterpointsService.getLastCycle();
      if (!last) throw new Error('No cycles found');
      ({ cycleId } = last); // destructuring assignment
    }

    const cycle = await mongoChatterpointsService.getCycleById(cycleId);
    if (!cycle) throw new Error('Cycle not found');

    const totalPoints = cycle.totalsByUser.find((t) => t.userId === req.userId)?.points ?? 0;

    const { periodsPlayed, wins } = cycle.periods.reduce(
      (acc, p) => {
        const u = p.plays.find((x) => x.userId === req.userId);
        if (u) {
          acc.periodsPlayed += 1;
          acc.wins += u.won ? 1 : 0;
        }
        return acc;
      },
      { periodsPlayed: 0, wins: 0 }
    );

    const userProfile = await getDisplayUserLabel(req.userId);
    return { userId: req.userId, userProfile, cycleId, totalPoints, periodsPlayed, wins };
  },

  getLeaderboard: async (
    req: LeaderboardRequest
  ): Promise<
    Array<{ position: number; trophy?: string; user: string; points: number; prize: number }>
  > => {
    const top = req.top ?? 3;

    let { cycleId } = req;
    if (!cycleId) {
      const last = await mongoChatterpointsService.getLastCycle();
      ({ cycleId } = last ?? {});
      if (!cycleId) return [];
    }

    const rows = await mongoChatterpointsService.getLeaderboardTop(cycleId, top);
    if (!rows.length) return [];

    const uniqueIds = [...new Set(rows.map((r) => r.userId))];
    const labels = await Promise.all(uniqueIds.map((id) => getDisplayUserLabel(id)));
    const byId = new Map<string, string>(uniqueIds.map((id, i) => [id, labels[i]]));

    const trophyFor = (pos: number): string | undefined => {
      const trophies: Record<number, string> = {
        1: '🥇',
        2: '🥈',
        3: '🥉'
      };
      return trophies[pos];
    };

    return rows.map((r, idx) => ({
      position: idx + 1,
      trophy: trophyFor(idx + 1),
      user: byId.get(r.userId) ?? r.userId,
      points: r.points,
      prize: r.prize // 👈 NEW
    }));
  }
};
