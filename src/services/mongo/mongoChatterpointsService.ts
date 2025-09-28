import { FilterQuery, UpdateQuery } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import { newDateUTC } from '../../helpers/timeHelper';
import { ConcurrentOperationsEnum } from '../../types/commonType';
import {
  GamePeriod,
  PeriodWord,
  TotalsByUser,
  IChatterpoints,
  OperationEntry,
  PeriodUserPlays,
  ChatterpointsModel,
  IChatterpointsDocument
} from '../../models/chatterpointsModel';

/**
 * Low-level Mongo access layer for Chatterpoints using Mongoose.
 * This module provides persistence primitives, atomic updates, and read queries.
 * Business rules and orchestration belong in the service layer.
 */

export interface CreateCycleInput {
  startAt: Date;
  endAt: Date;
  games: IChatterpoints['games'];
  operations?: IChatterpoints['operations'];
  periods: Array<Omit<GamePeriod, 'periodId'> & { word: PeriodWord }>;
  podiumPrizes?: number[];
}

export interface SocialRegInput {
  userId: string;
  platform: 'discord' | 'youtube' | 'x' | 'instagram' | 'linkedin';
  at: Date;
}

export interface LeaderboardItem {
  userId: string;
  points: number;
  prize: number;
}

export interface LeaderboardResponse {
  cycle: {
    cycleId: string;
    startAt: Date;
    endAt: Date;
  };
  currentPeriod: {
    periodId: string;
    startAt: Date | null;
    endAt: Date | null;
  };
  items: LeaderboardItem[];
}

/**
 * Build the default operations configuration (rules and empty entries).
 *
 * @returns {{config: IChatterpoints['operations']['config']; entries: IChatterpoints['operations']['entries']}}
 * Returns a configuration object with rules for all eligible operations and empty entries.
 */
function buildDefaultOperationsConfig() {
  const userLevels = ['L1', 'L2'] as const;

  const excluded = new Set([
    ConcurrentOperationsEnum.MintNft,
    ConcurrentOperationsEnum.MintNftCopy,
    ConcurrentOperationsEnum.WithdrawAll
  ]);

  const operations = Object.values(ConcurrentOperationsEnum).filter((op) => !excluded.has(op));

  const ranges = [
    { min: 0, max: 100, basePoints: 0.5, fullCount: 10, decayFactor: 0.7 },
    { min: 101, max: 500, basePoints: 0.2, fullCount: 8, decayFactor: 0.6 },
    { min: 501, max: 1000, basePoints: 0.1, fullCount: 5, decayFactor: 0.5 },
    { min: 1001, max: 5000, basePoints: 0.05, fullCount: 3, decayFactor: 0.5 },
    { min: 5000, max: 9999999999, basePoints: 0.01, fullCount: 2, decayFactor: 0.4 }
  ];

  const config = userLevels.flatMap((level) =>
    operations.flatMap((op) =>
      ranges.map((r) => ({
        type: op,
        userLevel: level,
        minAmount: r.min,
        maxAmount: r.max,
        basePoints: r.basePoints,
        fullCount: r.fullCount,
        decayFactor: r.decayFactor
      }))
    )
  );

  return { config, entries: [] };
}

/**
 * Pad a number to 2 digits with leading zero.
 *
 * @param {number} n - Number to pad.
 * @returns {string} Two-digit zero-padded string.
 */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Generate a unique cycleId based on UTC date/time and randomness.
 *
 * @param {Date} d - Date used to generate the ID.
 * @returns {string} Unique cycle identifier.
 */
function makeCycleId(d: Date): string {
  const yy = d.getUTCFullYear().toString();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const ms = d.getUTCMilliseconds().toString().padStart(3, '0');
  const rand = Math.random().toString().slice(2, 8).padStart(6, '0');
  return `${yy}${mm}${dd}-${hh}${mi}${ss}-${ms}${rand}`;
}

/**
 * Generate a unique periodId inside a cycle.
 *
 * @param {string} cycleId - Parent cycle identifier.
 * @param {number} index - Zero-based period index.
 * @returns {string} Unique period identifier for the cycle.
 */
function makePeriodId(cycleId: string, index: number): string {
  return `${cycleId}-p${index + 1}`;
}

export const mongoChatterpointsService = {
  /**
   * Retrieve the current open cycle (status = OPEN).
   *
   * @returns {Promise<IChatterpointsDocument|null>} Resolves with the open cycle or null when not found.
   */
  getOpenCycle: async (): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({ status: 'OPEN' }).lean<IChatterpointsDocument>().exec(),

  /**
   * Retrieve the last created cycle ordered by startAt descending.
   *
   * @returns {Promise<IChatterpointsDocument|null>} Resolves with the most recent cycle or null.
   */
  getLastCycle: async (): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({}).sort({ startAt: -1 }).lean<IChatterpointsDocument>().exec(),

  /**
   * Create a new cycle document.
   * Generates a cycleId, assigns sequential periodIds, opens the first period, and persists all input.
   *
   * @param {CreateCycleInput} input - Cycle creation payload (games, periods, time window and optional operations/prizes).
   * @returns {Promise<IChatterpointsDocument>} Resolves with the created cycle document (lean object).
   */
  createCycle: async (input: CreateCycleInput): Promise<IChatterpointsDocument> => {
    const cycleId = makeCycleId(input.startAt ?? newDateUTC());
    const periods = input.periods.map((p, idx) => ({
      ...p,
      periodId: makePeriodId(cycleId, idx),
      status: idx === 0 ? 'OPEN' : 'CLOSED'
    }));
    const doc = await ChatterpointsModel.create({
      cycleId,
      status: 'OPEN',
      startAt: input.startAt,
      endAt: input.endAt,
      podiumPrizes: input.podiumPrizes ?? [0, 0, 0],
      games: input.games,
      operations: input.operations ?? buildDefaultOperationsConfig(),
      periods,
      socialActions: [],
      totalsByUser: []
    });
    return doc.toObject() as unknown as IChatterpointsDocument;
  },

  /**
   * Close a cycle by setting status = CLOSED.
   *
   * @param {string} cycleId - Cycle identifier.
   * @returns {Promise<void>} Resolves when the update has been persisted.
   */
  closeCycleById: async (cycleId: string): Promise<void> => {
    await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
  },

  /**
   * Add a social registration if not already present (idempotent).
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {SocialRegInput} reg - Social registration payload.
   * @returns {Promise<boolean>} Resolves true when the registration was inserted; false otherwise.
   */
  addSocialRegistration: async (cycleId: string, reg: SocialRegInput): Promise<boolean> => {
    const res = await ChatterpointsModel.updateOne(
      // NOTE: field used for dedupe is the socialActions array; we guard by userId
      { cycleId, 'socialRegistrations.userId': { $ne: reg.userId }, status: 'OPEN' },
      { $push: { socialActions: reg } }
    ).exec();
    return res.modifiedCount > 0;
  },

  /**
   * Resolve the active period for a game at a given moment.
   *
   * Behavior:
   *  - If exactly one OPEN period matches the current time window → returns it.
   *  - If multiple OPEN periods overlap → closes all but the latest by startAt, returns the chosen one.
   *  - If no OPEN period is valid:
   *      * closes any OPEN-but-expired periods,
   *      * opens the CLOSED period whose time window contains `now`, if any,
   *      * otherwise opens the next future CLOSED period if one exists,
   *      * finally, if no future periods remain and the cycle window has ended, closes the cycle.
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {string} gameId - Game identifier.
   * @param {Date} now - Current time reference (UTC).
   * @returns {Promise<{ cycle: IChatterpointsDocument; period: GamePeriod } | null>}
   * Resolves with the (cycle, active period) pair or null when none applies.
   * @throws {Error} Propagates I/O errors from Mongo if updates fail.
   */
  getActivePeriod: async (
    cycleId: string,
    gameId: string,
    now: Date
  ): Promise<{ cycle: IChatterpointsDocument; period: GamePeriod } | null> => {
    const cycle = await ChatterpointsModel.findOne({ cycleId, status: 'OPEN' })
      .lean<IChatterpointsDocument>()
      .exec();
    if (!cycle) return null;

    const nowTs = now.getTime();
    const candidates = cycle.periods.filter((p) => p.gameId === gameId && p.status === 'OPEN');

    // Single valid open period
    const valid = candidates.filter(
      (p) => new Date(p.startAt).getTime() <= nowTs && nowTs < new Date(p.endAt).getTime()
    );
    if (valid.length === 1) {
      return { cycle, period: valid[0] };
    }

    // Multiple overlapping open periods → keep the most recent, close others
    if (valid.length > 1) {
      const chosen = valid.sort((a, b) => b.startAt.getTime() - a.startAt.getTime())[0];
      await Promise.all(
        valid
          .filter((p) => p.periodId !== chosen.periodId)
          .map((p) =>
            ChatterpointsModel.updateOne(
              { cycleId, 'periods.periodId': p.periodId },
              { $set: { 'periods.$.status': 'CLOSED' } }
            )
          )
      );
      return { cycle, period: chosen };
    }

    // No valid open periods → close expired ones
    await Promise.all(
      candidates.map((p) =>
        ChatterpointsModel.updateOne(
          { cycleId, 'periods.periodId': p.periodId },
          { $set: { 'periods.$.status': 'CLOSED' } }
        )
      )
    );

    // Refresh snapshot after closing
    const refreshedCycle = await ChatterpointsModel.findOne({ cycleId })
      .lean<IChatterpointsDocument>()
      .exec();
    if (!refreshedCycle) return null;

    // 1) Open CLOSED period that currently contains `now`
    const currentClosed = refreshedCycle.periods.find(
      (p) =>
        p.gameId === gameId &&
        p.status === 'CLOSED' &&
        new Date(p.startAt).getTime() <= nowTs &&
        nowTs < new Date(p.endAt).getTime()
    );
    if (currentClosed) {
      await ChatterpointsModel.updateOne(
        { cycleId, 'periods.periodId': currentClosed.periodId },
        { $set: { 'periods.$.status': 'OPEN' } }
      ).exec();
      return { cycle: refreshedCycle, period: currentClosed };
    }

    // 2) Otherwise open the next future CLOSED period
    const nextPeriod = refreshedCycle.periods.find(
      (p) => p.gameId === gameId && p.status === 'CLOSED' && new Date(p.startAt).getTime() > nowTs
    );
    if (nextPeriod) {
      await ChatterpointsModel.updateOne(
        { cycleId, 'periods.periodId': nextPeriod.periodId },
        { $set: { 'periods.$.status': 'OPEN' } }
      ).exec();
      return { cycle: refreshedCycle, period: nextPeriod };
    }

    // 3) If nothing to open and cycle already expired → close the cycle
    if (
      refreshedCycle.periods.every((p) => p.status === 'CLOSED') &&
      new Date(refreshedCycle.endAt).getTime() <= nowTs
    ) {
      await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
    }

    return null;
  },

  /**
   * Append a play entry for a user in a given period and update totals.
   *
   * Semantics:
   *  - Ensures the user's subdocument exists in the period (creates if missing).
   *  - Increments attempt counter and appends the attempt entry.
   *  - Tracks the user's best score in the period via $max(totalPoints).
   *  - Recomputes cycle-wide totalsByUser (games + operations + social).
   *  - Emits debug logs with snapshots.
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {string} periodId - Period identifier.
   * @param {string} userId - User identifier.
   * @param {object} entry - Play attempt payload.
   * @param {string} entry.guess - Guess content (word or letter).
   * @param {number} entry.points - Points awarded to this attempt.
   * @param {string} [entry.result] - Optional compact result encoding (e.g. Wordle mask).
   * @param {Date} entry.at - Attempt timestamp.
   * @param {boolean} entry.won - True if the attempt completed the game successfully.
   * @param {number} entry.attemptNumber - 1-based attempt number.
   * @param {Record<string, unknown>} [entry.displayInfo] - Optional UI-facing metadata.
   * @returns {Promise<void>} Resolves after persistence completes.
   * @throws {Error} When the target period is closed.
   */
  pushPlayEntry: async (
    cycleId: string,
    periodId: string,
    userId: string,
    entry: {
      guess: string;
      points: number;
      result?: string;
      at: Date;
      won: boolean;
      attemptNumber: number;
      displayInfo?: Record<string, unknown>;
    }
  ): Promise<void> => {
    const cycle = await ChatterpointsModel.findOne(
      { cycleId, status: 'OPEN', 'periods.periodId': periodId },
      { periods: { $elemMatch: { periodId } } }
    )
      .lean<IChatterpointsDocument>()
      .exec();

    if (!cycle || cycle.periods[0].status !== 'OPEN') {
      Logger.warn(
        '[pushPlayEntry] rejected play: period is CLOSED cycleId=%s periodId=%s',
        cycleId,
        periodId
      );
      throw new Error('Period closed');
    }

    const filterPeriod: FilterQuery<IChatterpointsDocument> = {
      cycleId,
      'periods.periodId': periodId,
      status: 'OPEN'
    };

    Logger.debug(
      '[pushPlayEntry] START cycleId=%s periodId=%s userId=%s attemptNumber=%s',
      cycleId,
      periodId,
      userId,
      entry.attemptNumber
    );

    // Ensure user subdocument exists
    const hasUser = await ChatterpointsModel.findOne(
      {
        cycleId,
        status: 'OPEN',
        periods: {
          $elemMatch: {
            periodId,
            'plays.userId': userId
          }
        }
      },
      { _id: 1 }
    )
      .lean()
      .exec();

    Logger.debug('[pushPlayEntry] hasUser=%s', Boolean(hasUser));

    // Insert minimal user subdoc if missing
    if (!hasUser) {
      const insRes = await ChatterpointsModel.updateOne(
        { cycleId, 'periods.periodId': periodId, status: 'OPEN' },
        {
          $push: {
            'periods.$[p].plays': {
              userId,
              attempts: 0,
              won: false,
              totalPoints: 0,
              entries: [],
              lastUpdatedAt: entry.at
            }
          }
        },
        { arrayFilters: [{ 'p.periodId': periodId }] }
      ).exec();
      Logger.debug('[pushPlayEntry] inserted user subdoc modified=%d', insRes.modifiedCount);
    }

    // Update attempt and best period score
    const updatePlays: UpdateQuery<IChatterpointsDocument> = {
      $set: {
        'periods.$[p].plays.$[u].lastUpdatedAt': entry.at,
        'periods.$[p].plays.$[u].won': entry.won
      },
      $inc: {
        'periods.$[p].plays.$[u].attempts': 1
      },
      $max: {
        'periods.$[p].plays.$[u].totalPoints': entry.points
      },
      $push: {
        'periods.$[p].plays.$[u].entries': {
          at: entry.at,
          guess: entry.guess,
          points: entry.points,
          attemptNumber: entry.attemptNumber,
          ...(entry.result ? { result: entry.result } : {}),
          ...(entry.displayInfo ? { displayInfo: entry.displayInfo } : {})
        }
      }
    };

    const arrayFiltersPlays = [{ 'p.periodId': periodId }, { 'u.userId': userId }];

    Logger.debug(
      '[pushPlayEntry] plays:update filter=%s arrayFilters=%s',
      JSON.stringify(filterPeriod),
      JSON.stringify(arrayFiltersPlays)
    );

    const resPlays = await ChatterpointsModel.updateOne(filterPeriod, updatePlays, {
      arrayFilters: arrayFiltersPlays
    }).exec();

    Logger.debug(
      '[pushPlayEntry] plays:update matched=%d modified=%d',
      resPlays.matchedCount,
      resPlays.modifiedCount
    );

    // Recompute totalsByUser (games + operations + social)
    const cycleSnapshot = await ChatterpointsModel.findOne(
      { cycleId },
      { periods: 1, totalsByUser: 1 }
    )
      .lean<IChatterpointsDocument>()
      .exec();

    const allPeriods = cycleSnapshot?.periods || [];
    const userPeriodTotals = allPeriods
      .flatMap((p) => p.plays)
      .filter((pl) => pl.userId === userId)
      .map((pl) => pl.totalPoints ?? 0);

    const pointsGames = userPeriodTotals.reduce((a, b) => a + b, 0);

    const currentTotals = cycleSnapshot?.totalsByUser?.find((t) => t.userId === userId);
    const pointsOperations = currentTotals?.breakdown?.operations ?? 0;
    const pointsSocial = currentTotals?.breakdown?.social ?? 0;

    const cycleTotal = pointsGames + pointsOperations + pointsSocial;

    if (!currentTotals) {
      const totalsIns = await ChatterpointsModel.updateOne(
        { cycleId },
        {
          $push: {
            totalsByUser: {
              userId,
              total: cycleTotal,
              breakdown: {
                games: pointsGames,
                operations: pointsOperations,
                social: pointsSocial
              }
            }
          }
        }
      ).exec();
      Logger.debug('[pushPlayEntry] totals: insert modified=%d', totalsIns.modifiedCount);
    } else {
      const totalsSet = await ChatterpointsModel.updateOne(
        { cycleId, 'totalsByUser.userId': userId },
        {
          $set: {
            'totalsByUser.$.breakdown.games': pointsGames,
            'totalsByUser.$.total': cycleTotal
          }
        }
      ).exec();
      Logger.debug('[pushPlayEntry] totals: set modified=%d', totalsSet.modifiedCount);
    }

    // Snapshot for verification
    const finalSnapshot = await ChatterpointsModel.findOne(
      { cycleId, 'periods.periodId': periodId },
      { 'periods.$': 1, totalsByUser: 1 }
    )
      .lean<IChatterpointsDocument>()
      .exec();

    const plays: PeriodUserPlays[] = finalSnapshot?.periods?.[0]?.plays || [];
    const meFinal: PeriodUserPlays | undefined = plays.find((p) => p.userId === userId);

    const totalPoints: number =
      finalSnapshot?.totalsByUser?.find((t) => t.userId === userId)?.total ?? 0;

    Logger.debug(
      '[pushPlayEntry] snapshot period playsCount=%d myAttempts=%s myEntries=%s myPeriodTotal=%s myCycleTotal=%s',
      plays.length,
      meFinal?.attempts ?? null,
      meFinal?.entries?.length ?? null,
      meFinal?.totalPoints ?? null,
      totalPoints
    );
  },

  /**
   * Close a specific period (status = CLOSED).
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {string} periodId - Period identifier.
   * @returns {Promise<void>} Resolves after the update is persisted.
   */
  closePeriod: async (cycleId: string, periodId: string): Promise<void> => {
    await ChatterpointsModel.updateOne(
      { cycleId, 'periods.periodId': periodId },
      { $set: { 'periods.$.status': 'CLOSED' } }
    ).exec();
  },

  /**
   * Retrieve a cycle by its identifier.
   *
   * @param {string} id - Cycle identifier.
   * @returns {Promise<IChatterpointsDocument|null>} Resolves with the cycle or null when not found.
   */
  getCycleById: async (id: string): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({ cycleId: id }).lean<IChatterpointsDocument>().exec(),

  /**
   * Build the leaderboard for a cycle, with cycle metadata and current/last period.
   *
   * Logic:
   *  - If `cycleId` is missing, the latest cycle (open or closed) is used.
   *  - Users with total = 0 are filtered out.
   *  - Sorting: by total points (desc), then by total attempts (asc).
   *  - Prize assignment uses `podiumPrizes[idx]` when available.
   *
   * @param {string|undefined} cycleId - Optional cycle identifier.
   * @param {number} limit - Maximum number of leaderboard items.
   * @returns {Promise<LeaderboardResponse|null>} Leaderboard or null when no cycle exists.
   */
  getLeaderboardTop: async (
    cycleId: string | undefined,
    limit: number
  ): Promise<LeaderboardResponse | null> => {
    let target: string | undefined = cycleId;
    if (!target) {
      const last: IChatterpointsDocument | null = await mongoChatterpointsService.getLastCycle();
      if (!last) return null;
      target = last.cycleId;
    }

    const doc = await ChatterpointsModel.findOne(
      { cycleId: target },
      { cycleId: 1, startAt: 1, endAt: 1, totalsByUser: 1, podiumPrizes: 1, periods: 1 }
    )
      .lean<
        Pick<
          IChatterpointsDocument,
          'cycleId' | 'startAt' | 'endAt' | 'totalsByUser' | 'podiumPrizes' | 'periods'
        >
      >()
      .exec();

    if (!doc) return null;

    // Sum attempts per user across periods
    const attemptsByUser: Record<string, number> = {};
    doc.periods.forEach((p: GamePeriod) => {
      p.plays.forEach((play: PeriodUserPlays) => {
        attemptsByUser[play.userId] = (attemptsByUser[play.userId] ?? 0) + (play.attempts ?? 0);
      });
    });

    const podiumPrizes: number[] = Array.isArray(doc.podiumPrizes) ? doc.podiumPrizes : [0, 0, 0];
    const totals: TotalsByUser[] = Array.isArray(doc.totalsByUser) ? doc.totalsByUser : [];

    const nonZeroTotals: TotalsByUser[] = totals.filter((t: TotalsByUser) => (t.total ?? 0) > 0);

    const sorted: TotalsByUser[] = nonZeroTotals
      .slice()
      .sort((a: TotalsByUser, b: TotalsByUser) => {
        if (b.total !== a.total) return b.total - a.total;
        return (attemptsByUser[a.userId] ?? Infinity) - (attemptsByUser[b.userId] ?? Infinity);
      })
      .slice(0, limit);

    const items: LeaderboardItem[] = sorted.map<LeaderboardItem>(
      (u: TotalsByUser, idx: number) => ({
        userId: u.userId,
        points: u.total,
        prize: podiumPrizes[idx] ?? 0
      })
    );

    // Pick last period by endAt
    const lastPeriod: GamePeriod | undefined = [...doc.periods].sort(
      (a: GamePeriod, b: GamePeriod) => new Date(b.endAt).getTime() - new Date(a.endAt).getTime()
    )[0];

    return {
      cycle: {
        cycleId: doc.cycleId,
        startAt: doc.startAt,
        endAt: doc.endAt
      },
      currentPeriod: {
        periodId: lastPeriod?.periodId ?? '',
        startAt: lastPeriod?.startAt ?? null,
        endAt: lastPeriod?.endAt ?? null
      },
      items
    };
  },

  /**
   * Close all expired periods and cycles.
   *
   * Semantics:
   *  - For all OPEN cycles, CLOSE any period with endAt <= now.
   *  - If a cycle window has ended and all periods are CLOSED, set cycle status = CLOSED.
   *
   * Intended to be called by a scheduled job.
   *
   * @returns {Promise<{ closedPeriods: number; closedCycles: number }>}
   * Summary of how many periods and cycles were closed.
   */
  closeExpiredPeriodsAndCycles: async (): Promise<{
    closedPeriods: number;
    closedCycles: number;
  }> => {
    const nowTs: number = Date.now();

    const openCycles: IChatterpointsDocument[] = await ChatterpointsModel.find({ status: 'OPEN' })
      .lean<IChatterpointsDocument[]>()
      .exec();

    if (openCycles.length === 0) {
      Logger.debug('[closeExpiredPeriodsAndCycles] no OPEN cycles found');
      return { closedPeriods: 0, closedCycles: 0 };
    }

    // Close expired periods (endAt <= now)
    const expiredPeriods = openCycles.flatMap((cycle: IChatterpointsDocument) =>
      cycle.periods
        .filter((p: GamePeriod) => p.status === 'OPEN' && new Date(p.endAt).getTime() <= nowTs)
        .map(async (expired: GamePeriod) => {
          Logger.debug(
            '[closeExpiredPeriodsAndCycles] closing periodId=%s (cycleId=%s endAt=%s)',
            expired.periodId,
            cycle.cycleId,
            new Date(expired.endAt).toISOString()
          );
          await mongoChatterpointsService.closePeriod(cycle.cycleId, expired.periodId);
        })
    );

    // Close expired cycles (endAt <= now)
    const expiredCycles = openCycles
      .filter((c: IChatterpointsDocument) => new Date(c.endAt).getTime() <= nowTs)
      .map(async (expiredCycle: IChatterpointsDocument) => {
        Logger.debug(
          '[closeExpiredPeriodsAndCycles] closing cycleId=%s (endAt=%s)',
          expiredCycle.cycleId,
          new Date(expiredCycle.endAt).toISOString()
        );
        await mongoChatterpointsService.closeCycleById(expiredCycle.cycleId);
      });

    await Promise.all([...expiredPeriods, ...expiredCycles]);

    Logger.debug(
      '[closeExpiredPeriodsAndCycles] summary closedPeriods=%d closedCycles=%d',
      expiredPeriods.length,
      expiredCycles.length
    );

    return { closedPeriods: expiredPeriods.length, closedCycles: expiredCycles.length };
  },

  /**
   * Open periods that should be active now (status -> OPEN).
   *
   * Semantics:
   *  - For all OPEN cycles, any CLOSED period whose window contains `now` is set to OPEN.
   *
   * Intended to be called by a scheduled job.
   *
   * @returns {Promise<{ openedPeriods: number }>} Count of periods that transitioned to OPEN.
   */
  openUpcomingPeriods: async (): Promise<{ openedPeriods: number }> => {
    const nowTs: number = Date.now();

    const openCycles: IChatterpointsDocument[] = await ChatterpointsModel.find({ status: 'OPEN' })
      .lean<IChatterpointsDocument[]>()
      .exec();

    if (openCycles.length === 0) {
      Logger.debug('[openUpcomingPeriods] no OPEN cycles found');
      return { openedPeriods: 0 };
    }

    const periodsToOpen = openCycles.flatMap((cycle: IChatterpointsDocument) =>
      cycle.periods
        .filter(
          (p: GamePeriod) =>
            p.status === 'CLOSED' &&
            new Date(p.startAt).getTime() <= nowTs &&
            nowTs < new Date(p.endAt).getTime()
        )
        .map((p) => ({ cycleId: cycle.cycleId, periodId: p.periodId }))
    );

    if (periodsToOpen.length === 0) {
      Logger.debug('[openUpcomingPeriods] no periods matched criteria');
      return { openedPeriods: 0 };
    }

    await Promise.all(
      periodsToOpen.map(async (p) => {
        Logger.debug(
          '[openUpcomingPeriods] opening periodId=%s (cycleId=%s)',
          p.periodId,
          p.cycleId
        );
        await ChatterpointsModel.updateOne(
          { cycleId: p.cycleId, 'periods.periodId': p.periodId },
          { $set: { 'periods.$.status': 'OPEN' } }
        ).exec();
      })
    );

    return { openedPeriods: periodsToOpen.length };
  },

  /**
   * Append an operations entry and update totals for the user.
   *
   * Semantics:
   *  - If the user already exists in totalsByUser → push entry and increment totals (total and breakdown.operations).
   *  - Else → push entry and insert a new totalsByUser record initialized with the operation points.
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {OperationEntry} entry - Operation entry to persist.
   * @returns {Promise<void>} Resolves when the update is persisted.
   */
  addOperationEntry: async (cycleId: string, entry: OperationEntry): Promise<void> => {
    const updated = await ChatterpointsModel.updateOne(
      { cycleId, 'totalsByUser.userId': entry.userId },
      {
        $push: { 'operations.entries': entry },
        $inc: {
          'totalsByUser.$.total': entry.points,
          'totalsByUser.$.breakdown.operations': entry.points
        }
      }
    ).exec();

    if (updated.matchedCount === 0) {
      await ChatterpointsModel.updateOne(
        { cycleId },
        {
          $push: {
            'operations.entries': entry,
            totalsByUser: {
              userId: entry.userId,
              total: entry.points,
              breakdown: { games: 0, operations: entry.points, social: 0 }
            }
          }
        }
      ).exec();
    }
  }
};
