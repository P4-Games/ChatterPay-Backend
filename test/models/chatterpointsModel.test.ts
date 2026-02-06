import { beforeEach, describe, expect, it } from 'vitest';

import {
  ChatterpointsModel,
  type GameType,
  type PeriodStatus,
  type WindowUnit
} from '../../src/models/chatterpointsModel';

describe('Chatterpoints Model', () => {
  beforeEach(async () => {
    await ChatterpointsModel.syncIndexes();
  });

  const now = () => new Date();
  const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);

  function makeWordleGame(gameId = 'WORDLE-1') {
    return {
      gameId,
      type: 'WORDLE' as GameType,
      enabled: true,
      config: {
        type: 'WORDLE',
        settings: {
          wordLength: 5,
          periodWindow: { unit: 'DAYS' as WindowUnit, value: 1 },
          efficiencyPenalty: 2
        },
        points: {
          victoryBase: 50,
          failBase: 0,
          attemptPenalty: 5,
          efficiencyPenalty: 2
        }
      },
      usedWords: []
    };
  }

  function makeHangmanGame(gameId = 'HANGMAN-1') {
    return {
      gameId,
      type: 'HANGMAN' as GameType,
      enabled: true,
      config: {
        type: 'HANGMAN',
        settings: {
          wordLength: 6,
          periodWindow: { unit: 'DAYS' as WindowUnit, value: 1 },
          efficiencyPenalty: 1
        },
        points: {
          victoryBase: 40,
          failBase: 0,
          attemptPenalty: 3,
          efficiencyPenalty: 1
        }
      },
      usedWords: []
    };
  }

  it('should create and save a minimal valid cycle (WORDLE) with one period', async () => {
    const startAt = now();
    const endAt = addMinutes(startAt, 60 * 24);

    const doc = await ChatterpointsModel.create({
      cycleId: 'cycle-001',
      startAt,
      endAt,
      podiumPrizes: [15, 7, 3],
      games: [makeWordleGame('WORDLE-1')],
      // operations omitted on purpose → schema default {} with empty arrays
      // socialActions omitted → default []
      // periods: one period for the WORDLE game, status omitted to test default "CLOSED"
      periods: [
        {
          periodId: 'p-1',
          gameId: 'WORDLE-1',
          index: 0,
          word: { en: 'APPLE' },
          startAt,
          endAt: addMinutes(startAt, 60 * 24)
          // status omitted → should default to CLOSED
          // plays omitted → should default []
        }
      ]
      // totalsByUser omitted → default []
    });

    expect(doc).toBeTruthy();
    expect(doc._id).toBeDefined();
    expect(doc.status).toBe('OPEN'); // default at cycle level
    expect(doc.games.length).toBe(1);
    expect(doc.games[0].enabled).toBe(true);
    expect(doc.periods.length).toBe(1);
    expect(doc.periods[0].status).toBe('CLOSED'); // default at period level
    expect(Array.isArray(doc.periods[0].plays)).toBe(true);
    expect(doc.periods[0].plays.length).toBe(0);
    expect(Array.isArray(doc.totalsByUser)).toBe(true);
    expect(doc.totalsByUser.length).toBe(0);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
  });

  it('should accept multilingual words in periods (es/pt optional)', async () => {
    const startAt = now();
    const doc = await ChatterpointsModel.create({
      cycleId: 'cycle-002',
      startAt,
      endAt: addMinutes(startAt, 60),
      podiumPrizes: [0, 0, 0],
      games: [makeWordleGame('WORDLE-2')],
      periods: [
        {
          periodId: 'p-2',
          gameId: 'WORDLE-2',
          index: 0,
          word: { en: 'HOUSE', es: 'CASA', pt: 'CASA' },
          startAt,
          endAt: addMinutes(startAt, 60)
        }
      ]
    });

    expect(doc.periods[0].word.en).toBe('HOUSE');
    expect(doc.periods[0].word.es).toBe('CASA');
    expect(doc.periods[0].word.pt).toBe('CASA');
  });

  it('should default operations section (config/entries) to empty arrays', async () => {
    const startAt = now();
    const doc = await ChatterpointsModel.create({
      cycleId: 'cycle-003',
      startAt,
      endAt: addMinutes(startAt, 30),
      podiumPrizes: [0, 0, 0],
      games: [makeHangmanGame('HANGMAN-1')],
      periods: []
    });

    expect(doc.operations).toBeTruthy();
    expect(Array.isArray(doc.operations.config)).toBe(true);
    expect(Array.isArray(doc.operations.entries)).toBe(true);
    expect(doc.operations.config.length).toBe(0);
    expect(doc.operations.entries.length).toBe(0);
  });

  it('should enforce status enum at cycle level', async () => {
    const startAt = now();
    const invalid = ChatterpointsModel.create({
      cycleId: 'cycle-004',
      status: 'INVALID',
      startAt,
      endAt: addMinutes(startAt, 30),
      podiumPrizes: [0, 0, 0],
      games: [makeWordleGame('WORDLE-3')],
      periods: []
    });

    await expect(invalid).rejects.toThrow(/(is invalid|not a valid enum value)/i);
  });

  it('should enforce status enum at period level', async () => {
    const startAt = now();
    const invalid = ChatterpointsModel.create({
      cycleId: 'cycle-005',
      startAt,
      endAt: addMinutes(startAt, 60),
      podiumPrizes: [0, 0, 0],
      games: [makeWordleGame('WORDLE-4')],
      periods: [
        {
          periodId: 'p-5',
          gameId: 'WORDLE-4',
          index: 0,
          word: { en: 'PEACH' },
          startAt,
          endAt: addMinutes(startAt, 60),
          status: 'WRONG' as unknown as PeriodStatus
        }
      ]
    });

    // 🔧 CHANGE: same fix here
    await expect(invalid).rejects.toThrow(/(is invalid|not a valid enum value)/i);
  });

  it('should set defaults for PeriodUserPlays entries when added later', async () => {
    const startAt = now();
    const cycle = await ChatterpointsModel.create({
      cycleId: 'cycle-006',
      startAt,
      endAt: addMinutes(startAt, 60),
      podiumPrizes: [0, 0, 0],
      games: [makeWordleGame('WORDLE-5')],
      periods: [
        {
          periodId: 'p-6',
          gameId: 'WORDLE-5',
          index: 0,
          word: { en: 'MANGO' },
          startAt,
          endAt: addMinutes(startAt, 60)
        }
      ]
    });

    // Push a new user plays subdoc with minimal data and let defaults apply
    const updated = await ChatterpointsModel.findOneAndUpdate(
      { _id: cycle._id, 'periods.periodId': 'p-6' },
      {
        $push: {
          'periods.$.plays': {
            userId: 'u-1'
            // attempts/won/totalPoints/entries/lastUpdatedAt defaulted by schema
          }
        }
      },
      { new: true }
    );

    const { plays } = updated!.periods[0];
    expect(plays.length).toBe(1);
    expect(plays[0].userId).toBe('u-1');
    expect(plays[0].attempts).toBe(0);
    expect(plays[0].won).toBe(false);
    expect(plays[0].totalPoints).toBe(0);
    expect(Array.isArray(plays[0].entries)).toBe(true);
    expect(plays[0].entries.length).toBe(0);
    expect(plays[0].lastUpdatedAt).toBeInstanceOf(Date);
  });

  it('should create recommended indexes', async () => {
    const indexes = await ChatterpointsModel.collection.indexes();

    // Ensure string[]
    const names = indexes.map((i) => i.name ?? '').filter((s): s is string => s.length > 0);

    // Default _id_ plus model-defined ones
    expect(names).toContain('_id_');

    // status + endAt
    expect(names.find((n) => n.includes('status_1') && n.includes('endAt_1'))).toBeTruthy();

    // periods.gameId + periods.startAt
    expect(
      names.find((n) => n.includes('periods.gameId_1') && n.includes('periods.startAt_1'))
    ).toBeTruthy();

    // totalsByUser.points (see note about field name vs "total")
    expect(names.find((n) => n.includes('totalsByUser') && n.includes('-1'))).toBeTruthy();
  });
});
