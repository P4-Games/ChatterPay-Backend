import { type Document, model, Schema } from 'mongoose';

import { ConcurrentOperationsEnum } from '../types/commonType';

/**
 * Chatterpoints domain model
 *
 * One Mongo document == one "cycle".
 * Inside each cycle we persist: games configuration, generated periods, plays per user per period,
 * social registrations and precomputed totals for fast leaderboard queries.
 *
 * DESIGN DECISION — Why are "periods" stored at cycle root (not inside each game)?
 * --------------------------------------------------------------------------------
 * 1) Cross-game scheduling & reporting: opening/closing windows, finding the next/previous
 *    active period, and building leaderboards are transversal tasks across all games. Keeping a
 *    flat time-series (cycle.periods[]) allows simple, efficient scans and updates without
 *    navigating nested arrays (games[].periods[]).
 * 2) Write-path simplicity: high-frequency writes (user plays, points increments, status flips)
 *    benefit from shorter, stable update paths and simpler arrayFilters. A single positional
 *    match on periods[] is cheaper and less error-prone than matching games[] + periods[].
 * 3) Indexing strategy: time-range and status queries (e.g., { 'periods.gameId': 1, 'periods.startAt': 1 })
 *    remain straightforward with a flat array; nested paths often require more complex compound
 *    indexes and longer key paths with little functional gain for our current workloads.
 * 4) Evolution cost: the service layer can still return "view models" grouped by game (periods
 *    aggregated per game in-memory) without changing storage. If we ever introduce game-specific
 *    period schemas that diverge significantly, we can revisit nesting with a planned migration.
 */

/** Cycle/window enums */
export type CycleStatus = 'OPEN' | 'CLOSED';
export type WindowUnit = 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS';
export type GameType = 'WORDLE' | 'HANGMAN';
export type PeriodStatus = 'OPEN' | 'CLOSED';
export type SocialPlatform = 'discord' | 'youtube' | 'x' | 'instagram' | 'linkedin';

/** Rule defining how many points an operation grants */
export interface OperationPointsRule {
  type: ConcurrentOperationsEnum; // reuse existing enum
  minAmount: number; // minimum amount (e.g., USDT)
  maxAmount: number; // maximum amount
  userLevel: string; // L1, L2, etc.
  basePoints: number; // base multiplier to compute final points
  fullCount: number; // number of full-credit operations per user
  decayFactor: number; // multiplier applied after fullCount is exceeded
}

/** A concrete operation performed during a cycle */
export interface OperationEntry {
  operationId: string; // tx hash or internal id
  userId: string;
  type: ConcurrentOperationsEnum; // enum type
  amount: number;
  userLevel: string;
  points: number;
  at: Date;
}

/** Operations section inside the cycle */
export interface OperationsSection {
  config: OperationPointsRule[];
  entries: OperationEntry[];
}

export interface PeriodWord {
  en?: string;
  es?: string;
  pt?: string;
}

/** Time window configuration */
export interface TimeWindow {
  unit: WindowUnit;
  /** Duration in unit steps. Example: {unit:'MINUTES', value:5} */
  value: number;
}

/** Points configuration per game type (cycle-scoped) */
export interface WordlePointsConfig {
  /** Points when the user guesses the entire word within the period */
  victoryBase: number;
  /** Points per letter in correct position */
  letterExact: number;
  /** Points per letter present but wrong position */
  letterPresent: number;
}

export interface HangmanPointsConfig {
  /** Points when the user guesses the word */
  victoryBase: number;
  /** Penalty (negative or zero) if user loses */
  losePenalty: number;
  /** Fixed at 7, but kept configurable */
  maxWrongAttempts: number; // set default = 7
}

/** Generic per-game settings */
export interface WordleSettings {
  wordLength: number;
  attemptsPerUserPerPeriod: number;
  periodWindow: TimeWindow;
  /** Base points awarded when the word is guessed on the first attempt */
  victoryBase: number;
  /**
   * Penalty applied per additional attempt after the first.
   * Example: with penalty = 2 → 1st attempt = victoryBase,
   * 2nd attempt = victoryBase - 2, 3rd attempt = victoryBase - 4, etc.
   */
  efficiencyPenalty: number;
}

export interface HangmanSettings {
  wordLength: number;
  periodWindow: TimeWindow;
  efficiencyPenalty: number;
}

/** Union for settings/points per game */
export type GameSettings =
  | { type: 'WORDLE'; settings: WordleSettings; points: WordlePointsConfig }
  | { type: 'HANGMAN'; settings: HangmanSettings; points: HangmanPointsConfig };

/** Game configuration within a cycle */
export interface GameSection {
  gameId: string;
  type: GameType;
  enabled: boolean;
  /** Settings + points typed by union */
  config: GameSettings;
  /**
   * Words used in this cycle to avoid repetition across periods/cycles.
   * Now multilingual (one object per word with optional language keys).
   */
  usedWords: PeriodWord[];
}

/** One play attempt entry */
export interface PlayAttempt {
  guess: string;
  points: number;
  /** Optional compact result encoding (e.g., "GYY__") */
  result?: string;
  at: Date;
  /** Attempt number within the period (1-based) */
  attemptNumber?: number;
  /** Optional user-facing display info (Wordle grid, Hangman state, etc.) */
  displayInfo?: {
    // Hangman-specific state
    guessedLetters?: string[]; // all letters guessed so far
    correctLetters?: string[]; // optional: explicitly separate correct
    wrongLetters?: string[]; // letters guessed incorrectly
    remainingAttempts?: number; // attempts left until "hanged"
    wordProgress?: string; // e.g. "_ A _ _ O"
  };
}
/** Aggregated per-user record inside a period */
export interface PeriodUserPlays {
  userId: string;
  attempts: number;
  won: boolean;
  totalPoints: number;
  entries: PlayAttempt[];
  lastUpdatedAt: Date;
}

/** One generated period for a specific game inside the cycle */
export interface GamePeriod {
  periodId: string;
  gameId: string;
  index: number;
  word: PeriodWord;
  startAt: Date;
  endAt: Date;
  status: PeriodStatus;
  plays: PeriodUserPlays[];
}

export interface SocialSection {
  userId: string;
  platform: SocialPlatform;
  at: Date;
}

/** Precomputed totals for fast leaderboard (cycle-scoped) */
export interface TotalsByUser {
  userId: string;
  total: number;
  breakdown: {
    games: number;
    operations: number;
    social: number;
  };
}

/** Main cycle document */
export interface IChatterpoints {
  cycleId: string;
  status: CycleStatus;
  startAt: Date;
  endAt: Date;
  podiumPrizes: number[];
  games: GameSection[];
  operations: OperationsSection;
  /**
   * Flat time-series of game periods at cycle scope (see DESIGN DECISION above).
   * Each period references the target game via gameId to keep scheduling and reporting transversal.
   */
  periods: GamePeriod[];
  socialActions: SocialSection[];
  totalsByUser: TotalsByUser[];
  createdAt: Date;
  updatedAt: Date;
}

export type IChatterpointsDocument = Document<unknown, Record<string, never>, IChatterpoints> &
  IChatterpoints & { cycleId: string };

/** ---------- Schemas ---------- */

const OperationPointsRuleSchema = new Schema<OperationPointsRule>(
  {
    type: {
      type: String,
      enum: Object.values(ConcurrentOperationsEnum),
      required: true
    },
    minAmount: { type: Number, required: true },
    maxAmount: { type: Number, required: true },
    userLevel: { type: String, required: true },
    basePoints: { type: Number, required: true },
    fullCount: { type: Number, required: true, default: 5 },
    decayFactor: { type: Number, required: true, default: 0.5 }
  },
  { _id: false }
);

const OperationEntrySchema = new Schema<OperationEntry>(
  {
    operationId: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: Object.values(ConcurrentOperationsEnum),
      required: true
    },
    amount: { type: Number, required: true },
    userLevel: { type: String, required: true },
    points: { type: Number, required: true },
    at: { type: Date, required: true }
  },
  { _id: false }
);

const OperationsSchema = new Schema<OperationsSection>(
  {
    config: { type: [OperationPointsRuleSchema], required: true, default: [] },
    entries: { type: [OperationEntrySchema], required: true, default: [] }
  },
  { _id: false }
);

const PlayAttemptSchema = new Schema<PlayAttempt>(
  {
    at: { type: Date, required: true },
    guess: { type: String, required: true },
    points: { type: Number, required: true },
    result: { type: String, required: false },
    displayInfo: { type: Schema.Types.Mixed, required: false }
  },
  { _id: false }
);

const PeriodUserPlaysSchema = new Schema<PeriodUserPlays>(
  {
    userId: { type: String, required: true, index: true },
    attempts: { type: Number, required: true, default: 0 },
    won: { type: Boolean, required: true, default: false },
    totalPoints: { type: Number, required: true, default: 0 },
    entries: { type: [PlayAttemptSchema], required: true, default: [] },
    lastUpdatedAt: { type: Date, required: true, default: () => new Date() }
  },
  { _id: false }
);

const PeriodWordSchema = new Schema<PeriodWord>(
  {
    en: { type: String, required: false },
    es: { type: String, required: false },
    pt: { type: String, required: false }
  },
  { _id: false }
);

const GamePeriodSchema = new Schema<GamePeriod>(
  {
    periodId: { type: String, required: true },
    gameId: { type: String, required: true, index: true },
    index: { type: Number, required: true },
    word: { type: PeriodWordSchema, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], required: true, default: 'CLOSED' },
    plays: { type: [PeriodUserPlaysSchema], required: true, default: [] }
  },
  { _id: false }
);

const GameSettingsSchema = new Schema<GameSettings>(
  {
    type: { type: String, enum: ['WORDLE', 'HANGMAN'], required: true },
    settings: {
      type: Schema.Types.Mixed,
      required: true
    },
    points: {
      type: Schema.Types.Mixed,
      required: true
    }
  },
  { _id: false, discriminatorKey: 'type' }
);

const SocialActionsSchema = new Schema<SocialSection>(
  {
    userId: { type: String, required: true },
    platform: {
      type: String,
      enum: ['discord', 'youtube', 'x', 'instagram', 'linkedin'],
      required: true
    },
    at: { type: Date, required: true }
  },
  { _id: false }
);

const GameSchema = new Schema<GameSection>(
  {
    gameId: { type: String, required: true },
    type: { type: String, enum: ['WORDLE', 'HANGMAN'], required: true },
    enabled: { type: Boolean, required: true, default: true },
    config: { type: GameSettingsSchema, required: true },
    usedWords: { type: [PeriodWordSchema], required: true, default: [] }
  },
  { _id: false }
);

const TotalsByUserSchema = new Schema<TotalsByUser>(
  {
    userId: { type: String, required: true, index: true },
    total: { type: Number, required: true, default: 0, index: true },
    breakdown: {
      games: { type: Number, required: true, default: 0 },
      operations: { type: Number, required: true, default: 0 },
      social: { type: Number, required: true, default: 0 }
    }
  },
  { _id: false }
);

const ChatterpointsSchema = new Schema<IChatterpoints>(
  {
    cycleId: { type: String, required: true },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED'],
      required: true,
      default: 'OPEN',
      index: true
    },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true, index: true },
    podiumPrizes: { type: [Number], required: true, default: [0, 0, 0] },
    games: { type: [GameSchema], required: true, default: [] },
    operations: { type: OperationsSchema, required: true, default: { config: [], entries: [] } },
    socialActions: { type: [SocialActionsSchema], required: true, default: [] },
    /**
     * Flat array kept at cycle scope (see DESIGN DECISION above).
     * Each record links to its game via gameId.
     */
    periods: { type: [GamePeriodSchema], required: true, default: [] },
    totalsByUser: { type: [TotalsByUserSchema], required: true, default: [] }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

/** Recommended indexes */
ChatterpointsSchema.index({ status: 1, endAt: 1 });
ChatterpointsSchema.index({ 'periods.gameId': 1, 'periods.startAt': 1 });
ChatterpointsSchema.index({ 'totalsByUser.points': -1 });

export const ChatterpointsModel = model<IChatterpoints>('chatterpoints', ChatterpointsSchema);
