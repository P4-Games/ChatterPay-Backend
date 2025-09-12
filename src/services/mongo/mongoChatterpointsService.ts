import { FilterQuery, UpdateQuery } from 'mongoose';

import { Logger } from '../../helpers/loggerHelper';
import {
  IChatterpoints,
  ChatterpointsModel,
  IChatterpointsDocument
} from '../../models/chatterpointsModel';

/**
 * Low-level Mongo access layer for Chatterpoints using Mongoose.
 * No business logic here; only data persistence, atomic updates and queries.
 */

export interface CreateCycleInput {
  startAt: Date;
  endAt: Date;
  games: IChatterpoints['games'];
  periods: IChatterpoints['periods'];
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

// Helpers
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
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
function makePeriodId(cycleId: string, index: number): string {
  return `${cycleId}-p${index + 1}`;
}

export const mongoChatterpointsService = {
  getOpenCycle: async (): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({ status: 'OPEN' }).lean<IChatterpointsDocument>().exec(),

  getLastCycle: async (): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({}).sort({ startAt: -1 }).lean<IChatterpointsDocument>().exec(),

  createCycle: async (input: CreateCycleInput): Promise<IChatterpointsDocument> => {
    // 1. always generate a cycleId
    const cycleId = makeCycleId(input.startAt ?? new Date());

    // 2. assign a periodId to each period
    const periods = input.periods.map((p, idx) => ({
      ...p,
      periodId: makePeriodId(cycleId, idx)
    }));

    // 3. insert document
    const doc = await ChatterpointsModel.create({
      cycleId,
      status: 'OPEN',
      startAt: input.startAt,
      endAt: input.endAt,
      podiumPrizes: input.podiumPrizes ?? [0, 0, 0],
      games: input.games,
      periods,
      socialRegistrations: [],
      totalsByUser: []
    });

    return doc.toObject() as unknown as IChatterpointsDocument;
  },

  /** Close the cycle by id and set CLOSED status */
  closeCycleById: async (cycleId: string): Promise<void> => {
    await ChatterpointsModel.updateOne({ cycleId }, { $set: { status: 'CLOSED' } }).exec();
  },

  /** Idempotent social registration; adds record only if not present */
  addSocialRegistration: async (cycleId: string, reg: SocialRegInput): Promise<boolean> => {
    const res = await ChatterpointsModel.updateOne(
      { cycleId, 'socialRegistrations.userId': { $ne: reg.userId }, status: 'OPEN' },
      { $push: { socialRegistrations: reg } }
    ).exec();
    return res.modifiedCount > 0;
  },

  /** Append a play entry inside a specific period for a specific user */
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
      displayInfo?: Record<string, unknown>;
    }
  ): Promise<void> => {
    const filterPeriod: FilterQuery<IChatterpointsDocument> = {
      cycleId,
      'periods.periodId': periodId,
      status: 'OPEN'
    };

    Logger.debug(
      '[pushPlayEntry] START cycleId=%s periodId=%s userId=%s',
      cycleId,
      periodId,
      userId
    );

    // 0) ¿Existe ya el subdoc del usuario?
    const hasUser = await ChatterpointsModel.findOne(
      { ...filterPeriod, 'periods.plays.userId': userId },
      { _id: 1 }
    )
      .lean()
      .exec();

    Logger.debug('[pushPlayEntry] hasUser=%s', Boolean(hasUser));

    // 1) Si NO existe, insertar subdoc mínimo
    if (!hasUser) {
      const insRes = await ChatterpointsModel.updateOne(filterPeriod, {
        $push: {
          'periods.$.plays': {
            userId,
            attempts: 0, // empezamos en 0; el update siguiente lo incrementa a 1
            won: false, // estado por defecto; el caller sabe si won en cada entry
            totalPoints: 0,
            entries: [],
            lastUpdatedAt: entry.at
          }
        }
      }).exec();
      Logger.debug('[pushPlayEntry] inserted user subdoc modified=%d', insRes.modifiedCount);
    }

    // 2) Update de jugada (incrementos + push de entry)
    const updatePlays: UpdateQuery<IChatterpointsDocument> = {
      $set: { 'periods.$[p].plays.$[u].lastUpdatedAt': entry.at },
      $inc: {
        'periods.$[p].plays.$[u].attempts': 1,
        'periods.$[p].plays.$[u].totalPoints': entry.points
      },
      $push: {
        'periods.$[p].plays.$[u].entries': {
          at: entry.at,
          guess: entry.guess,
          points: entry.points,
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

    // 3) Totals (separado para que no contamine el modifiedCount de plays)
    const totalsIns = await ChatterpointsModel.updateOne(
      { cycleId, 'totalsByUser.userId': { $ne: userId } },
      { $push: { totalsByUser: { userId, points: entry.points } } }
    ).exec();
    Logger.debug('[pushPlayEntry] totals: insert-if-missing modified=%d', totalsIns.modifiedCount);

    const totalsInc = await ChatterpointsModel.updateOne(
      { cycleId, 'totalsByUser.userId': userId },
      { $inc: { 'totalsByUser.$.points': entry.points } }
    ).exec();
    Logger.debug('[pushPlayEntry] totals: increment modified=%d', totalsInc.modifiedCount);

    // 4) Snapshot para verificar qué quedó
    const snapshot = await ChatterpointsModel.findOne(
      { cycleId, 'periods.periodId': periodId },
      { 'periods.$': 1, totalsByUser: 1 }
    )
      .lean<IChatterpointsDocument>()
      .exec();

    const plays = snapshot?.periods?.[0]?.plays || [];
    const me = plays.find((p) => p.userId === userId);
    Logger.debug(
      '[pushPlayEntry] snapshot period playsCount=%d myAttempts=%s myEntries=%s myTotal=%s',
      plays.length,
      me?.attempts ?? null,
      me?.entries?.length ?? null,
      me?.totalPoints ?? null
    );
  },
  /** Close a period explicitly */
  closePeriod: async (cycleId: string, periodId: string): Promise<void> => {
    await ChatterpointsModel.updateOne(
      { cycleId, 'periods.periodId': periodId },
      { $set: { 'periods.$.status': 'CLOSED' } }
    ).exec();
  },

  /** Read helpers */
  getCycleById: async (id: string): Promise<IChatterpointsDocument | null> =>
    ChatterpointsModel.findOne({ cycleId: id }).lean<IChatterpointsDocument>().exec(),
  // Returns leaderboard items with cycle metadata
  getLeaderboardTop: async (
    cycleId: string,
    limit: number
  ): Promise<LeaderboardResponse | null> => {
    const doc = await ChatterpointsModel.findOne(
      { cycleId },
      { cycleId: 1, startAt: 1, endAt: 1, totalsByUser: 1, podiumPrizes: 1 }
    )
      .lean<
        Pick<
          IChatterpointsDocument,
          'cycleId' | 'startAt' | 'endAt' | 'totalsByUser' | 'podiumPrizes'
        >
      >()
      .exec();

    if (!doc) return null;

    const totals = Array.isArray(doc.totalsByUser) ? doc.totalsByUser : [];
    const sorted = totals
      .slice()
      .sort((a, b) => b.points - a.points)
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
  }
};
