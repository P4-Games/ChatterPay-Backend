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
   * Retrieve the current open cycle (status = OPEN) after time-based normalization.
   *
   * Normalization rules (time is authoritative):
   *  - Close expired OPEN cycles (endAt <= now) and their lingering OPEN periods.
   *  - For remaining OPEN cycles:
   *      • Close expired periods (endAt <= now).
   *      • Close early-opened periods (startAt > now).
   *
   * @returns {Promise<IChatterpointsDocument|null>} Resolves with the in-window OPEN cycle (startAt <= now < endAt) or null.
   */
  getOpenCycle: async (): Promise<IChatterpointsDocument | null> => {
    const now = new Date();

    // 1) Close expired OPEN cycles and any leftover OPEN periods inside them
    const expiredCycles = await ChatterpointsModel.updateMany(
      { status: 'OPEN', endAt: { $lte: now } },
      { $set: { status: 'CLOSED' } }
    ).exec();

    if (expiredCycles.modifiedCount > 0) {
      await ChatterpointsModel.updateMany(
        { status: 'CLOSED', endAt: { $lte: now } },
        { $set: { 'periods.$[p].status': 'CLOSED' } },
        { arrayFilters: [{ 'p.status': 'OPEN' }] }
      ).exec();
    }

    // 2) Normalize periods across remaining OPEN cycles
    // 2.a) Close expired OPEN periods
    await ChatterpointsModel.updateMany(
      { status: 'OPEN' },
      { $set: { 'periods.$[p].status': 'CLOSED' } },
      { arrayFilters: [{ 'p.status': 'OPEN', 'p.endAt': { $lte: now } }] }
    ).exec();

    // 2.b) Close early-opened periods (OPEN but startAt > now)
    await ChatterpointsModel.updateMany(
      { status: 'OPEN' },
      { $set: { 'periods.$[p].status': 'CLOSED' } },
      { arrayFilters: [{ 'p.status': 'OPEN', 'p.startAt': { $gt: now } }] }
    ).exec();

    // 3) Return the OPEN cycle that actually contains "now"
    return ChatterpointsModel.findOne({
      status: 'OPEN',
      startAt: { $lte: now },
      endAt: { $gt: now }
    })
      .sort({ startAt: -1 })
      .lean<IChatterpointsDocument>()
      .exec();
  },

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
    Logger.info('createCycle', 'creating', {
      startAt: input.startAt,
      endAt: input.endAt,
      games: input.games?.length ?? 0,
      periods: input.periods?.length ?? 0
    });

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

    Logger.info('createCycle', 'created', { cycleId, periods: periods.length });
    return doc.toObject() as unknown as IChatterpointsDocument;
  },

  /**
   * Close a cycle and all its periods in a single atomic update on the document.
   *
   * - Sets cycle.status = 'CLOSED'
   * - Sets every period.status = 'CLOSED' (only those not already CLOSED)
   *
   * @param {string} cycleId - Cycle identifier.
   * @returns {Promise<void>} Resolves when the update has been persisted.
   */
  closeCycleById: async (cycleId: string): Promise<void> => {
    await ChatterpointsModel.updateOne(
      { cycleId },
      {
        $set: {
          status: 'CLOSED',
          'periods.$[p].status': 'CLOSED'
        }
      },
      {
        arrayFilters: [{ 'p.status': { $ne: 'CLOSED' } }]
      }
    ).exec();

    Logger.info('closeCycleById', 'closed cycle and all periods', { cycleId });
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
      // NOTE: guard by userId; see suggestions to verify the path matches the schema
      { cycleId, 'socialRegistrations.userId': { $ne: reg.userId }, status: 'OPEN' },
      { $push: { socialActions: reg } }
    ).exec();

    const inserted = res.modifiedCount > 0;
    if (inserted) {
      Logger.info('addSocialRegistration', 'inserted', {
        cycleId,
        userId: reg.userId,
        platform: reg.platform
      });
    } else {
      Logger.debug('addSocialRegistration', 'skipped (already present or cycle closed)', {
        cycleId,
        userId: reg.userId
      });
    }
    return inserted;
  },

  /**
   * Time is authoritative. This function reconciles period/cycle states by "now":
   * - If the cycle is NOT OPEN:
   *    • Close all periods (regardless of dates)
   *    • Close the cycle if past endAt and all periods are CLOSED
   *    • Return null
   * - If the cycle IS OPEN:
   *    • Close EXPIRED periods across ALL games (endAt <= now)
   *    • Close EARLY-OPENED periods (startAt > now but status === OPEN)
   *    • For the requested gameId:
   *        – Find all in-window periods (startAt <= now < endAt)
   *        – If multiple, keep the latest by startAt and close the rest
   *        – Ensure the chosen one is OPEN and return it
   *    • If none is in-window, return null
   *    • If now >= endAt and all periods are CLOSED, close the cycle
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {string} gameId - Game identifier.
   * @param {Date} now - Current time reference (UTC).
   * @returns {Promise<{ cycle: IChatterpointsDocument; period: GamePeriod } | null>}
   */
  getActivePeriod: async (
    cycleId: string,
    gameId: string,
    now: Date
  ): Promise<{ cycle: IChatterpointsDocument; period: GamePeriod } | null> => {
    Logger.debug('getActivePeriod', 'start', { cycleId, gameId, now });

    // Load cycle regardless of status to allow normalization even when not OPEN
    let cycle = await ChatterpointsModel.findOne({ cycleId }).exec();
    if (!cycle) {
      Logger.debug('getActivePeriod', 'cycle not found', { cycleId });
      return null;
    }

    const nowTs = now.getTime();

    /**
     * If cycle is NOT OPEN:
     * - Close all periods (normalize to CLOSED)
     * - Close cycle if past endAt and all CLOSED
     * - Return null
     */
    if (cycle.status !== 'OPEN') {
      const hadOpen = cycle.periods.some((p) => p.status === 'OPEN');

      if (hadOpen) {
        await ChatterpointsModel.updateOne(
          { cycleId },
          { $set: { 'periods.$[p].status': 'CLOSED' } },
          { arrayFilters: [{ 'p.status': 'OPEN' }] }
        ).exec();
        Logger.info('getActivePeriod', 'closed all OPEN periods because cycle is not OPEN', {
          cycleId
        });
      }

      // Optionally close cycle if time passed and all periods are closed
      cycle = await ChatterpointsModel.findOne({ cycleId }).exec();
      if (
        cycle &&
        new Date(cycle.endAt).getTime() <= nowTs &&
        cycle.periods.every((p) => p.status === 'CLOSED') &&
        cycle.status !== 'CLOSED'
      ) {
        await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
        Logger.info('getActivePeriod', 'closed cycle after normalization (not OPEN)', { cycleId });
      }

      Logger.debug('getActivePeriod', 'no OPEN cycle after normalization', { cycleId });
      return null;
    }

    /**
     * Cycle is OPEN → First, homogeneous time-based normalization across ALL games:
     * - Close expired OPEN periods: endAt <= now
     * - Close early-opened periods: startAt > now (should not be OPEN yet)
     */
    const closeExpired = await ChatterpointsModel.updateOne(
      { cycleId },
      { $set: { 'periods.$[p].status': 'CLOSED' } },
      { arrayFilters: [{ 'p.status': 'OPEN', 'p.endAt': { $lte: now } }] }
    ).exec();

    if (closeExpired.modifiedCount > 0) {
      Logger.info('getActivePeriod', 'closed expired periods across ALL games', {
        cycleId,
        modified: closeExpired.modifiedCount
      });
    }

    const closeEarlyOpened = await ChatterpointsModel.updateOne(
      { cycleId },
      { $set: { 'periods.$[p].status': 'CLOSED' } },
      { arrayFilters: [{ 'p.status': 'OPEN', 'p.startAt': { $gt: now } }] }
    ).exec();

    if (closeEarlyOpened.modifiedCount > 0) {
      Logger.info('getActivePeriod', 'closed early-opened periods across ALL games', {
        cycleId,
        modified: closeEarlyOpened.modifiedCount
      });
    }

    // Refresh cycle after time-based normalization
    cycle = await ChatterpointsModel.findOne({ cycleId, status: 'OPEN' }).exec();
    if (!cycle) {
      Logger.debug('getActivePeriod', 'cycle became non-OPEN after normalization', { cycleId });
      return null;
    }

    /**
     * Resolve in-window periods for the requested game:
     *   startAt <= now < endAt
     */
    const inWindow: GamePeriod[] = cycle.periods.filter(
      (p) =>
        p.gameId === gameId &&
        new Date(p.startAt).getTime() <= nowTs &&
        nowTs < new Date(p.endAt).getTime()
    );

    if (inWindow.length === 0) {
      // No active window for this game at this time
      // If we are past cycle end and everything closed, close the cycle.
      if (
        new Date(cycle.endAt).getTime() <= nowTs &&
        cycle.periods.every((p) => p.status === 'CLOSED')
      ) {
        await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
        Logger.info('getActivePeriod', 'closed cycle after last period (no in-window)', {
          cycleId
        });
      }

      Logger.debug('getActivePeriod', 'no in-window period for game', { cycleId, gameId });
      return null;
    }

    // If multiple in-window (overlap), keep the latest by startAt, close the others
    const chosen = [...inWindow].sort((a, b) => b.startAt.getTime() - a.startAt.getTime())[0];
    const toCloseIds = inWindow
      .filter((p) => p.periodId !== chosen.periodId)
      .map((p) => p.periodId);

    if (toCloseIds.length > 0) {
      await ChatterpointsModel.updateOne(
        { cycleId },
        { $set: { 'periods.$[p].status': 'CLOSED' } },
        { arrayFilters: [{ 'p.periodId': { $in: toCloseIds } }] }
      ).exec();
      Logger.warn('getActivePeriod', 'overlap detected; closed older in-window periods', {
        cycleId,
        gameId,
        closed: toCloseIds
      });
    }

    // Ensure chosen is OPEN
    if (chosen.status !== 'OPEN') {
      await ChatterpointsModel.updateOne(
        { cycleId, 'periods.periodId': chosen.periodId },
        { $set: { 'periods.$.status': 'OPEN' } }
      ).exec();
      Logger.info('getActivePeriod', 'opened chosen in-window period', {
        cycleId,
        gameId,
        periodId: chosen.periodId
      });
    }

    // Optional refresh; keep it consistent with your document type
    const finalRaw = await ChatterpointsModel.findOne({ cycleId, status: 'OPEN' }).exec();
    const finalCycle = (finalRaw ?? cycle) as unknown as IChatterpointsDocument;

    // If end passed and everything closed, close cycle (race guard)
    if (
      new Date(finalCycle.endAt).getTime() <= nowTs &&
      finalCycle.periods.every((p) => p.status === 'CLOSED')
    ) {
      await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
      Logger.info('getActivePeriod', 'closed cycle after reconciliation', { cycleId });
    }

    return { cycle: finalCycle, period: chosen };
  },

  /**
   * Append a play entry for a user in a given period and update totals.
   *
   * @param {string} cycleId - Cycle identifier.
   * @param {string} periodId - Period identifier.
   * @param {string} userId - User identifier.
   * @param {object} entry - Play attempt payload.
   * @returns {Promise<void>} Resolves after persistence completes.
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
      Logger.warn('pushPlayEntry', 'rejected play: period is CLOSED', { cycleId, periodId });
      throw new Error('Period closed');
    }

    const filterPeriod: FilterQuery<IChatterpointsDocument> = {
      cycleId,
      'periods.periodId': periodId,
      status: 'OPEN'
    };

    Logger.debug('pushPlayEntry', 'START', {
      cycleId,
      periodId,
      userId,
      attemptNumber: entry.attemptNumber
    });

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

    Logger.debug('pushPlayEntry', 'hasUser', { hasUser: Boolean(hasUser) });

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
      Logger.debug('pushPlayEntry', 'inserted user subdoc', { modified: insRes.modifiedCount });
    }

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

    Logger.debug('pushPlayEntry', 'plays:update', {
      filter: filterPeriod,
      arrayFilters: arrayFiltersPlays
    });

    const resPlays = await ChatterpointsModel.updateOne(filterPeriod, updatePlays, {
      arrayFilters: arrayFiltersPlays
    }).exec();

    Logger.debug('pushPlayEntry', 'plays:result', {
      matched: resPlays.matchedCount,
      modified: resPlays.modifiedCount
    });

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
      Logger.debug('pushPlayEntry', 'totals:insert', { modified: totalsIns.modifiedCount });
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
      Logger.debug('pushPlayEntry', 'totals:update', { modified: totalsSet.modifiedCount });
    }

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

    Logger.debug('pushPlayEntry', 'snapshot', {
      playsCount: plays.length,
      myAttempts: meFinal?.attempts ?? null,
      myEntries: meFinal?.entries?.length ?? null,
      myPeriodTotal: meFinal?.totalPoints ?? null,
      myCycleTotal: totalPoints
    });
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
    Logger.debug('closePeriod', 'closed', { cycleId, periodId });
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

    const lastPeriod: GamePeriod | undefined = [...doc.periods].sort(
      (a: GamePeriod, b: GamePeriod) => new Date(b.endAt).getTime() - new Date(a.endAt).getTime()
    )[0];

    const response: LeaderboardResponse = {
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

    Logger.debug('getLeaderboardTop', 'built leaderboard', {
      cycleId: response.cycle.cycleId,
      items: response.items.length
    });

    return response;
  },

  /**
   * Close all expired periods and cycles.
   *
   * @returns {Promise<{ closedPeriods: number; closedCycles: number }>}
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
      Logger.debug('closeExpiredPeriodsAndCycles', 'no OPEN cycles found');
      return { closedPeriods: 0, closedCycles: 0 };
    }

    const expiredPeriods = openCycles.flatMap((cycle: IChatterpointsDocument) =>
      cycle.periods
        .filter((p: GamePeriod) => p.status === 'OPEN' && new Date(p.endAt).getTime() <= nowTs)
        .map(async (expired: GamePeriod) => {
          Logger.debug('closeExpiredPeriodsAndCycles', 'closing period', {
            periodId: expired.periodId,
            cycleId: cycle.cycleId,
            endAt: new Date(expired.endAt).toISOString()
          });
          await mongoChatterpointsService.closePeriod(cycle.cycleId, expired.periodId);
        })
    );

    const expiredCycles = openCycles
      .filter((c: IChatterpointsDocument) => new Date(c.endAt).getTime() <= nowTs)
      .map(async (expiredCycle: IChatterpointsDocument) => {
        Logger.debug('closeExpiredPeriodsAndCycles', 'closing cycle', {
          cycleId: expiredCycle.cycleId,
          endAt: new Date(expiredCycle.endAt).toISOString()
        });
        await mongoChatterpointsService.closeCycleById(expiredCycle.cycleId);
      });

    await Promise.all([...expiredPeriods, ...expiredCycles]);

    Logger.info('closeExpiredPeriodsAndCycles', 'summary', {
      closedPeriods: expiredPeriods.length,
      closedCycles: expiredCycles.length
    });

    return { closedPeriods: expiredPeriods.length, closedCycles: expiredCycles.length };
  },

  /**
   * Open periods that should be active now (status -> OPEN).
   *
   * @returns {Promise<{ openedPeriods: number }>} Count of periods that transitioned to OPEN.
   */
  openUpcomingPeriods: async (): Promise<{ openedPeriods: number }> => {
    const nowTs: number = Date.now();

    const openCycles: IChatterpointsDocument[] = await ChatterpointsModel.find({ status: 'OPEN' })
      .lean<IChatterpointsDocument[]>()
      .exec();

    if (openCycles.length === 0) {
      Logger.debug('openUpcomingPeriods', 'no OPEN cycles found');
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
      Logger.debug('openUpcomingPeriods', 'no periods matched criteria');
      return { openedPeriods: 0 };
    }

    await Promise.all(
      periodsToOpen.map(async (p) => {
        Logger.debug('openUpcomingPeriods', 'opening period', {
          cycleId: p.cycleId,
          periodId: p.periodId
        });
        await ChatterpointsModel.updateOne(
          { cycleId: p.cycleId, 'periods.periodId': p.periodId },
          { $set: { 'periods.$.status': 'OPEN' } }
        ).exec();
      })
    );

    Logger.info('openUpcomingPeriods', 'summary', { openedPeriods: periodsToOpen.length });
    return { openedPeriods: periodsToOpen.length };
  },

  /**
   * Append an operations entry and update totals for the user.
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
      Logger.debug('addOperationEntry', 'inserted totals record', {
        cycleId,
        userId: entry.userId,
        points: entry.points
      });
    } else {
      Logger.debug('addOperationEntry', 'updated totals record', {
        cycleId,
        userId: entry.userId,
        points: entry.points
      });
    }
  },

  /**
   * Retrieve a scheduled cycle that is already marked as OPEN but has not started yet.
   * This prevents creating a new cycle that would overlap once it begins.
   *
   * @returns {Promise<IChatterpointsDocument|null>} The next early-OPEN cycle, or null.
   */
  getScheduledOpenCycle: async (): Promise<IChatterpointsDocument | null> => {
    const now = new Date();
    return ChatterpointsModel.findOne({
      status: 'OPEN',
      startAt: { $gt: now }
    })
      .sort({ startAt: 1 }) // earliest to start
      .lean<IChatterpointsDocument>()
      .exec();
  }
};
