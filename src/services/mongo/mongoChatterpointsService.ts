import { FilterQuery, UpdateQuery } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import { newDateUTC } from '../../helpers/timeHelper';
import { ConcurrentOperationsEnum } from '../../types/commonType';
import {
  GamePeriod,
  PeriodWord,
  IChatterpoints,
  OperationEntry,
  ChatterpointsModel,
  IChatterpointsDocument
} from '../../models/chatterpointsModel';

/**
 * Low-level Mongo access layer for Chatterpoints using Mongoose.
 * Only persistence, atomic updates and queries. No business logic.
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
  items: LeaderboardItem[];
}

function buildDefaultOperationsConfig() {
  const userLevels = ['L1', 'L2'] as const;

  const excluded = new Set([
    ConcurrentOperationsEnum.MintNft,
    ConcurrentOperationsEnum.MintNftCopy,
    ConcurrentOperationsEnum.WithdrawAll
  ]);

  const operations = Object.values(ConcurrentOperationsEnum).filter((op) => !excluded.has(op));

  const ranges = [
    { min: 0, max: 100, points: 5 },
    { min: 101, max: 500, points: 7 },
    { min: 501, max: 1000, points: 10 },
    { min: 1001, max: 5000, points: 20 },
    { min: 5000, max: 9999999999, points: 50 }
  ];

  const config = userLevels.flatMap((level) =>
    operations.flatMap((op) =>
      ranges.map((r) => ({
        type: op,
        userLevel: level,
        minAmount: r.min,
        maxAmount: r.max,
        points: r.points
      }))
    )
  );

  return { config, entries: [] };
}

/**
 * Pad a number to 2 digits with leading zero.
 *
 * @param {number} n Input number.
 * @returns {string} Zero-padded 2-digit string.
 */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Generate a unique cycleId based on UTC date/time and randomness.
 *
 * @param {Date} d Date used to generate ID.
 * @returns {string} Unique cycleId string.
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
 * @param {string} cycleId Parent cycle ID.
 * @param {number} index Zero-based index of the period.
 * @returns {string} Period ID.
 */
function makePeriodId(cycleId: string, index: number): string {
  return `${cycleId}-p${index + 1}`;
}

export const mongoChatterpointsService = {
  /**
   * Get the current open cycle (status = OPEN).
   *
   * @returns {Promise<IChatterpointsDocument|null>} Open cycle or null.
   */
  getOpenCycle: async (): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({ status: 'OPEN' }).lean<IChatterpointsDocument>().exec(),

  /**
   * Get the last created cycle ordered by startAt descending.
   *
   * @returns {Promise<IChatterpointsDocument|null>} Last cycle or null.
   */
  getLastCycle: async (): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({}).sort({ startAt: -1 }).lean<IChatterpointsDocument>().exec(),

  /**
   * Create a new cycle document.
   * Generates cycleId, assigns periodIds, and persists all input.
   *
   * @param {CreateCycleInput} input Cycle data.
   * @returns {Promise<IChatterpointsDocument>} Created cycle.
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
   * @param {string} cycleId Cycle ID.
   * @returns {Promise<void>}
   */
  closeCycleById: async (cycleId: string): Promise<void> => {
    await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
  },

  /**
   * Add a social registration if not already present.
   * Idempotent operation.
   *
   * @param {string} cycleId Cycle ID.
   * @param {SocialRegInput} reg Registration data.
   * @returns {Promise<boolean>} True if inserted.
   */
  addSocialRegistration: async (cycleId: string, reg: SocialRegInput): Promise<boolean> => {
    const res = await ChatterpointsModel.updateOne(
      { cycleId, 'socialRegistrations.userId': { $ne: reg.userId }, status: 'OPEN' },
      { $push: { socialActions: reg } }
    ).exec();
    return res.modifiedCount > 0;
  },

  /**
   * Get the active period for a game.
   *
   * Responsibilities:
   * - Checks if there is a valid active period for the given time (`now`).
   * - If multiple valid periods overlap → keeps the latest started and closes the others.
   * - If current open periods have expired → closes them.
   * - If there is a next scheduled period → opens it and returns it.
   * - If no future periods remain and all are closed → closes the entire cycle.
   *
   * @param {string} cycleId - Cycle ID.
   * @param {string} gameId - Game ID.
   * @param {Date} now - Current time reference.
   * @returns {Promise<{ cycle: IChatterpointsDocument; period: GamePeriod } | null>}
   * Resolves with the cycle + active period, or null if no active period is available.
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

    // Case: exactly one valid open period
    const valid = candidates.filter(
      (p) => new Date(p.startAt).getTime() <= nowTs && nowTs < new Date(p.endAt).getTime()
    );
    if (valid.length === 1) {
      return { cycle, period: valid[0] };
    }

    // Case: overlap edge case → keep the most recent, close others
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

    // Case: no valid open period → close expired ones
    await Promise.all(
      candidates.map((p) =>
        ChatterpointsModel.updateOne(
          { cycleId, 'periods.periodId': p.periodId },
          { $set: { 'periods.$.status': 'CLOSED' } }
        )
      )
    );

    // Refresh cycle after closing periods
    const refreshedCycle = await ChatterpointsModel.findOne({ cycleId })
      .lean<IChatterpointsDocument>()
      .exec();
    if (!refreshedCycle) return null;

    // 1) Reopen the period that is in the current time window (but marked CLOSED)
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

    // 2) If not inside a current one, find the next future CLOSED period
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

    // 3) If no next period exists and cycle already expired → close the cycle
    if (
      refreshedCycle.periods.every((p) => p.status === 'CLOSED') &&
      new Date(refreshedCycle.endAt).getTime() <= nowTs
    ) {
      await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
    }

    return null;
  },

  /**
   * Append a play entry for a user in a given period.
   *
   * Responsibilities:
   * - Ensures the user has a play subdocument in the period (inserts if missing).
   * - Increments the user's attempt counter.
   * - Pushes the new play attempt into the `entries` array with metadata.
   * - Updates `won` flag if the attempt resolves the game.
   * - Keeps the highest `totalPoints` achieved in the period (`$max`).
   * - Recomputes the user's total cycle points by summing the best score
   *   across all periods, and updates `totalsByUser`.
   * - Produces debug snapshots for verification.
   *
   * Supports both game types:
   * - **Wordle**: can accumulate partial points across attempts.
   * - **Hangman**: usually keeps `points=0` on intermediate letter guesses,
   *   and only assigns final points (victoryBase or losePenalty) once the
   *   game outcome is decided. `$max` ensures the final score is preserved.
   *
   * @param {string} cycleId - Parent cycle ID.
   * @param {string} periodId - Period ID where the play is recorded.
   * @param {string} userId - User performing the play.
   * @param {object} entry - Play attempt data.
   * @param {string} entry.guess - User guess (word or letter).
   * @param {number} entry.points - Points awarded for this attempt.
   * @param {string} [entry.result] - Optional compact result encoding.
   * @param {Date} entry.at - Timestamp of the attempt.
   * @param {boolean} entry.won - True if this attempt completes the game successfully.
   * @param {number} entry.attemptNumber - Attempt index within the period (1-based).
   * @param {Record<string, unknown>} [entry.displayInfo] - Extra user-facing details
   *   (e.g., Wordle grid, Hangman state).
   * @returns {Promise<void>} Resolves when persistence completes.
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

    // 0) Check if user subdoc already exists
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

    // 1) If NOT exists, insert minimal subdoc
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

    // 2) Update play (increment attempts, push entry, keep best points in period)
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

    // 3) TotalsByUser - accumulate the best period score into the cycle total
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

    const cycleTotal = userPeriodTotals.reduce((a, b) => a + b, 0);

    const userExistsInTotals = cycleSnapshot?.totalsByUser?.some((t) => t.userId === userId);

    if (!userExistsInTotals) {
      const totalsIns = await ChatterpointsModel.updateOne(
        { cycleId },
        { $push: { totalsByUser: { userId, points: cycleTotal } } }
      ).exec();
      Logger.debug('[pushPlayEntry] totals: insert modified=%d', totalsIns.modifiedCount);
    } else {
      const totalsSet = await ChatterpointsModel.updateOne(
        { cycleId, 'totalsByUser.userId': userId },
        { $set: { 'totalsByUser.$.points': cycleTotal } }
      ).exec();
      Logger.debug('[pushPlayEntry] totals: set modified=%d', totalsSet.modifiedCount);
    }

    // 4) Snapshot to verify persisted state
    const finalSnapshot = await ChatterpointsModel.findOne(
      { cycleId, 'periods.periodId': periodId },
      { 'periods.$': 1, totalsByUser: 1 }
    )
      .lean<IChatterpointsDocument>()
      .exec();

    const plays = finalSnapshot?.periods?.[0]?.plays || [];
    const meFinal = plays.find((p) => p.userId === userId);
    const totalPoints = finalSnapshot?.totalsByUser?.find((t) => t.userId === userId)?.points ?? 0;

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
   * Close a specific period by setting status = CLOSED.
   *
   * @param {string} cycleId Cycle ID.
   * @param {string} periodId Period ID.
   * @returns {Promise<void>}
   */
  closePeriod: async (cycleId: string, periodId: string): Promise<void> => {
    await ChatterpointsModel.updateOne(
      { cycleId, 'periods.periodId': periodId },
      { $set: { 'periods.$.status': 'CLOSED' } }
    ).exec();
  },

  /**
   * Get a cycle by its ID.
   *
   * @param {string} id Cycle ID.
   * @returns {Promise<IChatterpointsDocument|null>} Cycle or null.
   */
  getCycleById: async (id: string): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({ cycleId: id }).lean<IChatterpointsDocument>().exec(),

  /**
   * Get leaderboard with cycle metadata.
   *
   * - Resolves the target cycle:
   *   - If `cycleId` is provided, fetches that cycle.
   *   - If not, falls back to the last cycle (open or closed).
   * - Computes total attempts per user across all periods of the cycle.
   * - Sorts users by:
   *   1. Highest points (descending).
   *   2. If tied on points, the user with fewer attempts is ranked higher.
   * - Returns top N entries with cycle metadata and podium prizes.
   *
   * @param {string|undefined} cycleId Cycle ID or undefined.
   * @param {number} limit Max leaderboard items to return.
   * @returns {Promise<LeaderboardResponse|null>} Leaderboard or null if no cycle found.
   */
  getLeaderboardTop: async (
    cycleId: string | undefined,
    limit: number
  ): Promise<LeaderboardResponse | null> => {
    let target = cycleId;
    if (!target) {
      const last = await mongoChatterpointsService.getLastCycle();
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

    // Compute total attempts per user across all periods
    const attemptsByUser: Record<string, number> = {};
    doc.periods.forEach((p) => {
      p.plays.forEach((play) => {
        attemptsByUser[play.userId] = (attemptsByUser[play.userId] ?? 0) + (play.attempts ?? 0);
      });
    });

    const totals = Array.isArray(doc.totalsByUser) ? doc.totalsByUser : [];

    // filter out users with 0 points
    const nonZeroTotals = totals.filter((t) => (t.points ?? 0) > 0);

    // Sort first by points (desc), then by attempts (asc) in case of ties
    const sorted = nonZeroTotals
      .slice()
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        return (attemptsByUser[a.userId] ?? Infinity) - (attemptsByUser[b.userId] ?? Infinity);
      })
      .slice(0, limit);

    const podiumPrizes: number[] = Array.isArray(doc.podiumPrizes) ? doc.podiumPrizes : [0, 0, 0];

    const items: LeaderboardItem[] = sorted.map<LeaderboardItem>((u, idx) => ({
      userId: u.userId,
      points: u.points,
      prize: podiumPrizes[idx] ?? 0
    }));

    return {
      cycle: {
        cycleId: doc.cycleId,
        startAt: doc.startAt,
        endAt: doc.endAt
      },
      items
    };
  },

  /**
   * Close all expired periods and cycles (status = CLOSED).
   *
   * - Finds all cycles with status = OPEN.
   * - Closes periods whose endAt <= now.
   * - If all periods are CLOSED and cycle endAt <= now, closes the cycle.
   *
   * Intended for scheduled cleanup jobs.
   *
   * @returns {Promise<{ closedPeriods: number; closedCycles: number }>}
   */
  closeExpiredPeriodsAndCycles: async (): Promise<{
    closedPeriods: number;
    closedCycles: number;
  }> => {
    const nowTs: number = Date.now();

    // Get all cycles still marked as OPEN
    const openCycles: IChatterpointsDocument[] = await ChatterpointsModel.find({ status: 'OPEN' })
      .lean<IChatterpointsDocument[]>()
      .exec();

    if (openCycles.length === 0) {
      Logger.debug('[closeExpiredPeriodsAndCycles] no OPEN cycles found');
      return { closedPeriods: 0, closedCycles: 0 };
    }

    // 1) Close expired periods (endAt <= now)
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

    // 2) Close expired cycles (endAt <= now)
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
   * Open periods that should now be active (status = OPEN).
   *
   * - Finds cycles with status = OPEN.
   * - For each period with status = CLOSED and startAt <= now < endAt → set to OPEN.
   *
   * Intended for scheduled activation jobs.
   *
   * @returns {Promise<{ openedPeriods: number }>}
   */
  openUpcomingPeriods: async (): Promise<{ openedPeriods: number }> => {
    const nowTs: number = Date.now();

    // Find cycles still OPEN
    const openCycles: IChatterpointsDocument[] = await ChatterpointsModel.find({ status: 'OPEN' })
      .lean<IChatterpointsDocument[]>()
      .exec();

    if (openCycles.length === 0) {
      Logger.debug('[openUpcomingPeriods] no OPEN cycles found');
      return { openedPeriods: 0 };
    }

    // Collect periods that should be opened
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

    // Update all matching periods
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

  addOperationEntry: async (cycleId: string, entry: OperationEntry): Promise<void> => {
    // Try update totals if user already exists
    const updated = await ChatterpointsModel.updateOne(
      { cycleId, 'totalsByUser.userId': entry.userId },
      {
        $push: { 'operations.entries': entry },
        $inc: { 'totalsByUser.$.points': entry.points }
      }
    ).exec();

    if (updated.matchedCount === 0) {
      // User not in totals, insert new totals record
      await ChatterpointsModel.updateOne(
        { cycleId },
        {
          $push: {
            'operations.entries': entry,
            totalsByUser: { userId: entry.userId, points: entry.points }
          }
        }
      ).exec();
    }
  }
};
