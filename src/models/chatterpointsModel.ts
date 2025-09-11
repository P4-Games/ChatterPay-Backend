import { model, Schema, Document } from 'mongoose';

/**
 * Chatterpoints domain model
 *
 * One Mongo document == one "cycle".
 * Inside each cycle we persist: games configuration, generated periods, plays per user per period,
 * social registrations and precomputed totals for fast leaderboard queries.
 *
 * ⚠️ No `any` types. Everything is explicit.
 */

/** Cycle/window enums */
export type CycleStatus = 'OPEN' | 'CLOSED';
export type WindowUnit = 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS';
export type GameType = 'WORDLE' | 'HANGMAN';
export type PeriodStatus = 'OPEN' | 'CLOSED';
export type SocialPlatform = 'discord' | 'youtube' | 'x' | 'instagram' | 'linkedin';

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
  /** Max wrong attempts within the period (hangman rule) */
  maxWrongAttempts: number;
}

/** Generic per-game settings */
export interface WordleSettings {
  wordLength: number;
  attemptsPerUserPerPeriod: number;
  periodWindow: TimeWindow;
}

export interface HangmanSettings {
  wordLength: number;
  periodWindow: TimeWindow;
}

/** Union for settings/points per game */
export type GameSettings =
  | { type: 'WORDLE'; settings: WordleSettings; points: WordlePointsConfig }
  | { type: 'HANGMAN'; settings: HangmanSettings; points: HangmanPointsConfig };

/** Game configuration within a cycle */
export interface GameConfig {
  gameId: string;
  type: GameType;
  enabled: boolean;
  /** Settings + points typed by union */
  config: GameSettings;
  /**
   * Words used in this cycle to avoid repetition across periods/cycles.
   * When creating a new cycle, you must ensure uniqueness against previous cycles too.
   */
  usedWords: string[];
}

/** One play attempt entry */
export interface PlayAttempt {
  guess: string;
  points: number;
  /** Optional compact result encoding (e.g., "GYY__" for Wordle) */
  result?: string;
  at: Date;
  /** Optional user-facing display info (Wordle grid, Hangman state, etc.) */
  displayInfo?: Record<string, unknown>;
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
  word: string;
  startAt: Date;
  endAt: Date;
  status: PeriodStatus;
  plays: PeriodUserPlays[];
}

/** Social registration idempotent record */
export interface SocialRegistration {
  userId: string;
  platform: SocialPlatform;
  at: Date;
}

/** Precomputed totals for fast leaderboard (cycle-scoped) */
export interface TotalsByUser {
  userId: string;
  points: number;
}

/** Main cycle document */
export interface IChatterpoints {
  cycleId: string;
  status: CycleStatus;
  startAt: Date;
  endAt: Date;
  /** Podium prizes in stable coins for top 3 (index 0 = 1st, 1 = 2nd, 2 = 3rd) */
  podiumPrizes: number[];
  games: GameConfig[];
  periods: GamePeriod[];
  socialRegistrations: SocialRegistration[];
  totalsByUser: TotalsByUser[];
  createdAt: Date;
  updatedAt: Date;
}

export type IChatterpointsDocument = Document<unknown, Record<string, never>, IChatterpoints> &
  IChatterpoints & { cycleId: string };

/** ---------- Schemas ---------- */

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

const GamePeriodSchema = new Schema<GamePeriod>(
  {
    periodId: { type: String, required: true },
    gameId: { type: String, required: true, index: true },
    index: { type: Number, required: true },
    word: { type: String, required: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'CLOSED'], required: true, default: 'OPEN' },
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

const SocialRegistrationSchema = new Schema<SocialRegistration>(
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

const GameConfigSchema = new Schema<GameConfig>(
  {
    gameId: { type: String, required: true },
    type: { type: String, enum: ['WORDLE', 'HANGMAN'], required: true },
    enabled: { type: Boolean, required: true, default: true },
    config: { type: GameSettingsSchema, required: true },
    usedWords: { type: [String], required: true, default: [] }
  },
  { _id: false }
);

const TotalsByUserSchema = new Schema<TotalsByUser>(
  {
    userId: { type: String, required: true, index: true },
    points: { type: Number, required: true, default: 0, index: true }
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
    games: { type: [GameConfigSchema], required: true, default: [] },
    periods: { type: [GamePeriodSchema], required: true, default: [] },
    socialRegistrations: { type: [SocialRegistrationSchema], required: true, default: [] },
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
