import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { getGcpFile } from './gcp/gcpService';
import { Logger } from '../helpers/loggerHelper';
import { cacheService } from './cache/cacheService';
import { getDisplayUserLabel } from './userService';
import { mongoUserService } from './mongo/mongoUserService';
import { CacheNames, gamesLanguage, gamesLanguages } from '../types/commonType';
import {
  LeaderboardItem,
  LeaderboardResponse,
  mongoChatterpointsService
} from './mongo/mongoChatterpointsService';
import {
  GCP_CHATTERPOINTS,
  LOCAL_CHATTERPOINTS,
  GAMES_LANGUAGE_DEFAULT,
  CHATTERPOINTS_WORDS_SEED,
  CHATTERPOINTS_WORDS_READ_FROM
} from '../config/constants';
import {
  GameType,
  GameConfig,
  GamePeriod,
  PeriodWord,
  TimeWindow,
  CycleStatus,
  PlayAttempt,
  GameSettings,
  PeriodStatus,
  HangmanSettings,
  PeriodUserPlays,
  IChatterpointsDocument
} from '../models/chatterpointsModel';

// -------------------------------------------------------------------------------------------------------------

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

export interface ExpiredCleanupResult {
  closedPeriods: number;
  closedCycles: number;
}

type LeaderboardRow = {
  position: number;
  trophy?: string;
  user: string;
  points: number;
  prize: number;
};

type LeaderboardResult = {
  cycleId: string;
  cycleRange: string; // "startAt - endAt" for user display
  entries: LeaderboardRow[];
};

const DEFAULTS = {
  cycleDurationMinutes: 7 * 24 * 60, // weekly
  wordle: {
    wordLength: 7,
    attemptsPerUserPerPeriod: 6,
    periodWindow: { unit: 'DAYS', value: 1 } as TimeWindow,
    efficiencyPenalty: 2,
    points: { victoryBase: 50, letterExact: 5, letterPresent: 2 }
  },
  hangman: {
    wordLength: 7,
    periodWindow: { unit: 'DAYS', value: 1 } as TimeWindow,
    points: { victoryBase: 50, losePenalty: 0, maxWrongAttempts: 6 }
  }
} as const;

// -------------------------------------------------------------------------------------------------------------

/**
 * Retrieves a local Chatterpoints words file (encrypted JSON).
 *
 * @param {string} urlFile - The name of the words file to retrieve.
 * @returns {Promise<Record<string, Record<string, string[]>>>} The decrypted words dictionary.
 * @throws Throws an error if the local file cannot be retrieved.
 */
const getLocalChatterpointsWordsFile = async (
  urlFile: string
): Promise<Record<string, Record<string, string>>> => {
  try {
    const filePath = path.resolve(__dirname, urlFile);
    Logger.log('getLocalChatterpointsWordsFile', 'Looking for file in:', filePath);

    if (!fs.existsSync(filePath)) {
      throw new Error(`The file does not exist at path: ${filePath}`);
    }

    // 🚨 Devuelve JSON encriptado, no hace decrypt
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, Record<string, string>>;
  } catch (error) {
    Logger.error('getLocalChatterpointsWordsFile', urlFile, (error as Error).message);
    throw new Error('Error retrieving local Chatterpoints words file');
  }
};

/**
 * Retrieves a Chatterpoints words file from cache or fetches it (from local or GCP).
 *
 * @param {string} fileKey - The key of the words file to retrieve.
 * @returns {Promise<Record<string, Record<string, string[]>>>} The decrypted words dictionary.
 */
const getChatterpointsWordFile = async (
  fileKey: string
): Promise<Record<string, Record<string, string>>> => {
  const wordsReadFromLocal = CHATTERPOINTS_WORDS_READ_FROM === 'local';
  const filePath = wordsReadFromLocal
    ? path.resolve(__dirname, LOCAL_CHATTERPOINTS[fileKey])
    : GCP_CHATTERPOINTS[fileKey];

  if (!filePath) {
    throw new Error(`Words path not found for key "${fileKey}" in CHATTERPOINTS (${filePath})`);
  }

  const cacheKey = filePath;

  const hit = cacheService.get<Record<string, Record<string, string>>>(
    CacheNames.CHATTERPOINTS_WORDS,
    cacheKey
  );
  if (hit) {
    Logger.log('getChatterpointsWordFile', `CACHE HIT key=${cacheKey}`);
    return hit;
  }

  const words = await cacheService.getOrLoad<Record<string, Record<string, string>>>(
    CacheNames.CHATTERPOINTS_WORDS,
    cacheKey,
    async () => {
      Logger.log(
        'getChatterpointsWordFile',
        `CACHE MISS key=${cacheKey} — loading from ${CacheNames.CHATTERPOINTS_WORDS}...`
      );
      return wordsReadFromLocal
        ? getLocalChatterpointsWordsFile(filePath)
        : ((await getGcpFile(filePath)) as Record<string, Record<string, string>>);
    }
  );

  return words;
};

/**
 * Decrypts a base64-encoded AES-256-CBC encrypted JSON string using a password.
 *
 * This function expects the input string to be a base64 representation of:
 * - The first 16 bytes: the initialization vector (IV).
 * - The rest: the ciphertext.
 *
 * The password is hashed with SHA-256 to derive the encryption key.
 * The decrypted result is parsed as JSON and returned as a string array.
 *
 * @param {string} base64Str - The base64-encoded encrypted string.
 * @param {string} pass - The password used to derive the decryption key.
 * @returns {string[]} The decrypted JSON content, parsed as a string array.
 *
 * @throws {Error} If decryption fails or the input cannot be parsed as JSON.
 */
function decryptJson(base64Str: string, pass: string): string[] {
  const encrypted = Buffer.from(base64Str, 'base64');
  const iv = encrypted.subarray(0, 16);
  const ciphertext = encrypted.subarray(16);
  const key = crypto.createHash('sha256').update(pass).digest();
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Loads and decrypts all words from the encrypted words dictionary file (`words.json`).
 *
 * - Supports multiple languages (currently: `en`, `es`, `pt`).
 * - Supports word lengths from `l5` up to `l15`.
 * - Uses the constant `CHATTERPOINTS_WORDS_SEED` as the decryption key.
 * - Results are cached in memory (`global.__wordsCache`) to avoid repeated decryption.
 *
 * @async
 * @function getWords
 * @returns {Promise<Record<string, Record<string, string[]>>>}
 * A nested record structure where:
 * - The first-level keys are word length identifiers (e.g., `"l5"`, `"l10"`).
 * - The second-level keys are language codes (`"en"`, `"es"`, `"pt"`).
 * - The values are arrays of decrypted words for the given length and language.
 *
 * @throws {Error} If the word file cannot be loaded or decryption fails.
 *
 * @example
 * const words = await getWords();
 * console.log(words["l5"]["en"]); // → Array of English words with length 5
 */
const getWords = async (): Promise<Record<string, Record<string, string[]>>> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalAny: any = global as any;
  if (globalAny.__wordsCache) {
    return globalAny.__wordsCache;
  }

  const encryptedDict = await getChatterpointsWordFile('Words');

  // Decrypt all words for all lengths and languages
  const decrypted: Record<string, Record<string, string[]>> = Object.keys(encryptedDict).reduce<
    Record<string, Record<string, string[]>>
  >(
    (acc, lenKey) => {
      const langs = encryptedDict[lenKey];
      acc[lenKey] = Object.keys(langs).reduce<Record<string, string[]>>(
        (langAcc, lang) => {
          langAcc[lang] = decryptJson(langs[lang], CHATTERPOINTS_WORDS_SEED);
          return langAcc;
        },
        {} as Record<string, string[]>
      );
      return acc;
    },
    {} as Record<string, Record<string, string[]>>
  );

  globalAny.__wordsCache = decrypted;
  return decrypted;
};

/**
 * Adds a given number of minutes to a date.
 *
 * @param {Date} date - The original date.
 * @param {number} minutes - The number of minutes to add (can be positive or negative).
 * @returns {Date} A new Date object with the minutes added.
 *
 * @example
 * const now = new Date();
 * const later = addMinutes(now, 30);
 * console.log(later); // → Date object 30 minutes ahead
 */
function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * Converts a TimeWindow object into minutes.
 *
 * Supports different time units:
 * - `MINUTES` → value in minutes
 * - `HOURS`   → value * 60
 * - `DAYS`    → value * 60 * 24
 * - `WEEKS`   → value * 60 * 24 * 7
 * If the unit is unknown, returns the raw value.
 *
 * @param {TimeWindow} w - The time window object with `{ unit, value }`.
 * @param {('MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS')} w.unit - The unit of time.
 * @param {number} w.value - The numeric value of the time window.
 * @returns {number} The equivalent duration in minutes.
 *
 * @example
 * const minutes = windowToMinutes({ unit: 'HOURS', value: 2 });
 * console.log(minutes); // → 120
 */
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
/**
 * Selects a random word of a given length for multiple languages from the dictionary.
 *
 * - Uses the `getWords()` dictionary loader, which provides words grouped by length and language.
 * - Generates a unique word for each supported language (`en`, `es`, `pt`) if available.
 * - Ensures uniqueness by checking against the provided `disallow` set with keys formatted as `lang:word`.
 * - Retries up to 1000 times per language to find a non-disallowed word.
 * - If no unique word is found after retries, it falls back to returning the first word
 *   in the list with a numeric suffix appended until a unique value is found (per language).
 *
 * @async
 * @function randomWord
 * @param {number} len - The desired word length (e.g., `5` for 5-letter words).
 * @param {Set<string>} disallow - A set of "lang:word" keys that must not be reused across languages.
 * @returns {Promise<PeriodWord>} An object containing random words per language (e.g., `{ en, es, pt }`).
 *
 * @throws {Error} If no words are available for the specified length in any language.
 *
 * @example
 * const disallowed = new Set<string>();
 * const word = await randomWord(5, disallowed);
 * console.log(word); // → { en: "house", es: "casa", pt: "casa" }
 */
async function randomWord(
  len: number,
  disallowByLang: Record<gamesLanguage, Set<string>>
): Promise<PeriodWord> {
  const dict = await getWords(); // dict: Record<string, Record<string, string[]>>
  const key = `l${len}`;
  const langs = [...gamesLanguages] as gamesLanguage[];

  const word: PeriodWord = {};

  langs.forEach((lang) => {
    const words = dict[key]?.[lang];
    if (words && words.length > 0) {
      const disallow = disallowByLang[lang];

      for (let i = 0; i < 1000; i += 1) {
        const candidate = words[Math.floor(Math.random() * words.length)];
        if (!disallow.has(candidate)) {
          disallow.add(candidate);
          word[lang] = candidate;
          break;
        }
      }

      if (!word[lang]) {
        let suffix = 0;
        while (disallow.has(`${words[0]}${suffix}`)) {
          suffix += 1;
        }
        const candidate = `${words[0]}${suffix}`;
        disallow.add(candidate);
        word[lang] = candidate;
      }
    }
  });

  return word;
}

/**
 * Expands a game configuration into multiple playable periods within a given date range.
 *
 * - Splits the game lifecycle into fixed-size time slots (periods) based on `periodWindow`.
 * - Each period receives a unique word, generated with `randomWord`, ensuring no duplicates.
 * - Returns an array of `GamePeriod` objects with metadata (ID, index, time window, word, etc.).
 *
 * @async
 * @function expandPeriodsForGame
 * @param {GameConfig} game - The game configuration object, including settings and used words.
 * @param {Date} startAt - The start date of the game cycle.
 * @param {Date} endAt - The end date of the game cycle.
 * @returns {Promise<GamePeriod[]>} An array of `GamePeriod` objects, one for each slot.
 *
 * @throws {Error} If word generation fails or no words can be assigned.
 *
 * @example
 * const periods = await expandPeriodsForGame(gameConfig, new Date(), addMinutes(new Date(), 120));
 * console.log(periods.length); // → Number of generated periods
 * console.log(periods[0].word); // → Random word assigned to the first period
 *
 * @remarks
 * - Periods are generated sequentially until reaching `endAt`.
 * - Word length defaults to `7` if not specified in the game config.
 * - The function retries word generation and ensures uniqueness via `disallow`.
 */
async function expandPeriodsForGame(
  game: GameConfig,
  startAt: Date,
  endAt: Date
): Promise<GamePeriod[]> {
  const minutes = windowToMinutes(game.config.settings.periodWindow as TimeWindow);

  // Initialize disallow sets per language
  const disallowByLang: Record<gamesLanguage, Set<string>> = Object.fromEntries(
    gamesLanguages.map((lang) => [lang, new Set<string>()])
  ) as Record<gamesLanguage, Set<string>>;

  // Pre-fill disallow sets with words already used in the game
  (game.usedWords ?? []).forEach((w) => {
    gamesLanguages.forEach((lang) => {
      if (w[lang]) {
        disallowByLang[lang].add(w[lang] as string);
      }
    });
  });

  // Build period slots
  const slots: { index: number; startAt: Date; endAt: Date }[] = [];
  let idx = 0;
  let cursor = new Date(startAt);

  while (cursor < endAt) {
    const next = addMinutes(cursor, minutes);
    if (next > endAt) break;
    slots.push({ index: idx, startAt: new Date(cursor), endAt: new Date(next) });
    idx += 1;
    cursor = next;
  }

  // Safe type narrowing for wordLength
  let wordLength = 7;
  const { type, settings } = game.config;

  if (type === 'WORDLE' || type === 'HANGMAN') {
    ({ wordLength } = settings);
  }

  // Generate multilingual words per slot (parallel)
  const words: PeriodWord[] = await Promise.all(
    slots.map(async () => randomWord(wordLength, disallowByLang))
  );

  // Build final periods
  return slots.map((slot, i) => ({
    periodId: `p${slot.index}`,
    gameId: game.gameId,
    index: slot.index,
    word: words[i],
    startAt: slot.startAt,
    endAt: slot.endAt,
    // only first period OPEN
    status: i === 0 ? 'OPEN' : ('CLOSED' as PeriodStatus),
    plays: []
  }));
}

/**
 * Creates a default game configuration for the specified game type.
 *
 * - Supports `WORDLE` and `HANGMAN`.
 * - Returns a `GameConfig` object initialized with default settings and points.
 * - Ensures `usedWords` starts as an empty array.
 *
 * @function defaultGameConfig
 * @param {GameType} type - The type of the game (`"WORDLE"` or `"HANGMAN"`).
 * @param {string} gameId - A unique identifier for the game instance.
 * @returns {GameConfig} A new `GameConfig` object with the appropriate defaults.
 *
 * @example
 * const wordleConfig = defaultGameConfig('WORDLE', 'game-123');
 * console.log(wordleConfig.config.settings.wordLength); // → default Wordle length
 *
 * @example
 * const hangmanConfig = defaultGameConfig('HANGMAN', 'game-456');
 * console.log(hangmanConfig.type); // → "HANGMAN"
 */
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
          periodWindow: DEFAULTS.wordle.periodWindow,
          victoryBase: DEFAULTS.wordle.points.victoryBase,
          efficiencyPenalty: DEFAULTS.wordle.efficiencyPenalty
        },
        points: DEFAULTS.wordle.points
      },
      usedWords: [] as PeriodWord[]
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
        periodWindow: DEFAULTS.hangman.periodWindow,
        efficiencyPenalty: DEFAULTS.wordle.efficiencyPenalty
      },
      points: DEFAULTS.hangman.points
    },
    usedWords: [] as PeriodWord[]
  };
}

/**
 * Validates that a game period fits correctly within a game cycle.
 *
 * - Ensures that the duration of a single period is strictly shorter
 *   than the total cycle duration.
 * - Throws an error if the constraint is violated.
 *
 * @function validatePeriodHierarchy
 * @param {number} cycleMinutes - The total duration of the game cycle, in minutes.
 * @param {number} periodMinutes - The duration of a single period, in minutes.
 * @throws {Error} If `periodMinutes` is greater than or equal to `cycleMinutes`.
 *
 * @example
 * validatePeriodHierarchy(120, 30); // ✅ valid
 *
 * @example
 * validatePeriodHierarchy(60, 60); // ❌ throws Error
 */
function validatePeriodHierarchy(cycleMinutes: number, periodMinutes: number): void {
  if (periodMinutes >= cycleMinutes) {
    throw new Error('Game period must be strictly shorter than cycle duration');
  }
}

/**
 * Handles the logic for playing a single round of the Wordle game.
 *
 * - Validates guess length against the configured word length.
 * - Calculates points for exact matches (🟩) and present-but-wrong-position matches (🟨).
 * - Applies efficiency penalty based on attempt number if the word is guessed correctly.
 * - Builds a result string and human-readable `displayInfo` for feedback.
 * - Persists the play entry in MongoDB through `mongoChatterpointsService.pushPlayEntry`.
 *
 * @async
 * @function playWordle
 * @param {string} cycleId - The unique identifier of the current cycle.
 * @param {string} periodId - The unique identifier of the active game period.
 * @param {PlayRequest} req - The incoming request containing user ID and guess.
 * @param {GamePeriod} period - The current active game period state.
 * @param {GameConfig} gameCfg - The game configuration, including Wordle rules and points.
 * @param {number} attemptNumber - The sequential number of the current attempt for this period.
 * @param {Date} now - The current timestamp of the play request.
 * @returns {Promise<{
 *   status: string;
 *   periodClosed: boolean;
 *   won: boolean;
 *   points: number;
 *   display_info?: Record<string, unknown>;
 * }>} An object describing the outcome of the play, including points and display info.
 *
 * @throws {Error} If the guess length does not match the expected Wordle word length.
 *
 * @example
 * const result = await playWordle("c123", "p1", req, period, cfg, 2, new Date());
 * console.log(result.display_info?.message);
 */
async function playWordle(
  cycleId: string,
  periodId: string,
  req: PlayRequest,
  period: GamePeriod,
  gameCfg: GameConfig,
  attemptNumber: number,
  now: Date,
  lang: gamesLanguage
): Promise<{
  status: string;
  periodClosed: boolean;
  won: boolean;
  points: number;
  display_info?: Record<string, unknown>;
}> {
  let won = false;
  let points = 0;
  let displayInfo: Record<string, unknown> = {};

  // Select answer word in requested language (default "en")
  const answerRaw = period.word[lang];
  if (!answerRaw) {
    throw new Error(`No word available for language=${lang} in this period`);
  }

  const answer = answerRaw.toLowerCase();
  const guess = req.guess.toLowerCase();
  const wordleCfg = gameCfg.config as Extract<GameSettings, { type: 'WORDLE' }>;
  const wordLen = wordleCfg.settings.wordLength;

  if (guess.length !== wordLen) {
    throw new Error(`Invalid guess length. Expected ${wordLen} letters.`);
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
      result += '?';
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
    won = true;
    const penalty = wordleCfg.settings.efficiencyPenalty ?? 2;
    points = Math.max(wordleCfg.points.victoryBase - penalty * (attemptNumber - 1), 0);
  }

  const prettyResult = result.replace(/G/g, '🟩').replace(/Y/g, '🟨').replace(/\?/g, '⬛');

  displayInfo = {
    guess: `${guess} → ${prettyResult}`,
    attempts: `${attemptNumber}/${wordleCfg.settings.attemptsPerUserPerPeriod}`,
    partialPoints: points,
    message: won ? 'You guessed the word!' : 'Keep trying.'
  };

  await mongoChatterpointsService.pushPlayEntry(cycleId, periodId, req.userId, {
    guess,
    points,
    result,
    at: now,
    won,
    attemptNumber,
    displayInfo
  });

  return { status: 'ok', periodClosed: false, won, points, display_info: displayInfo };
}

/**
 * Handles the logic for playing a single round of the Hangman game.
 *
 * - Accepts either a single letter guess or a full-word guess.
 * - Updates the state of guessed/correct/wrong letters.
 * - Awards victory points if the word is fully guessed (by letters or full word).
 * - Applies penalty if the user exhausts attempts or fails a full-word guess.
 * - Persists the play entry in MongoDB through `mongoChatterpointsService.pushPlayEntry`.
 *
 * @async
 * @function playHangman
 * @param {string} cycleId - The unique identifier of the current cycle.
 * @param {string} periodId - The unique identifier of the active game period.
 * @param {PlayRequest} req - The incoming request containing user ID and guess.
 * @param {GamePeriod} period - The current active game period state.
 * @param {GameConfig} gameCfg - The game configuration, including Hangman rules and points.
 * @param {number} attemptNumber - The sequential number of the current attempt for this period.
 * @param {Date} now - The current timestamp of the play request.
 * @param {gamesLanguage} lang - The language of the current game word.
 * @returns {Promise<{
 *   status: string;
 *   periodClosed: boolean;
 *   won: boolean;
 *   points: number;
 *   display_info?: Record<string, unknown>;
 * }>} An object describing the outcome of the play, including points and display info.
 *
 * @throws {Error} If the guess is not a single letter or a full word of correct length.
 */
async function playHangman(
  cycleId: string,
  periodId: string,
  req: PlayRequest,
  period: GamePeriod,
  gameCfg: GameConfig,
  attemptNumber: number,
  now: Date,
  lang: gamesLanguage
): Promise<{
  status: string;
  periodClosed: boolean;
  won: boolean;
  points: number;
  display_info?: Record<string, unknown>;
}> {
  let won = false;
  let points = 0;

  const answerRaw = period.word[lang];
  if (!answerRaw) throw new Error(`No word available for language=${lang} in this period`);
  const answer = answerRaw.toLowerCase();
  const guess = req.guess.toLowerCase();

  const hangmanCfg = gameCfg.config as Extract<GameSettings, { type: 'HANGMAN' }>;
  const settings = hangmanCfg.settings as HangmanSettings;

  // Default penalty = 10 if not configured
  const penalty: number = settings.efficiencyPenalty ?? 10;

  // Previous state
  const userPlays = period.plays.find((p) => p.userId === req.userId);
  const prevEntries = userPlays?.entries ?? [];
  const lastEntry = prevEntries[prevEntries.length - 1];

  const guessedLetters = new Set<string>(
    prevEntries.flatMap((e) => e.displayInfo?.guessedLetters ?? [])
  );
  const wrongLetters = new Set<string>(
    prevEntries.flatMap((e) => e.displayInfo?.wrongLetters ?? [])
  );

  // Remaining lives
  let remainingAttempts =
    typeof lastEntry?.displayInfo?.remainingAttempts === 'number'
      ? (lastEntry.displayInfo.remainingAttempts as number)
      : hangmanCfg.points.maxWrongAttempts;

  // --- GAME LOGIC ---
  if (guess.length === 1) {
    const letterU = guess.toUpperCase();
    if (!guessedLetters.has(letterU) && !wrongLetters.has(letterU)) {
      if (answer.includes(guess)) {
        guessedLetters.add(letterU); // correct
      } else {
        wrongLetters.add(letterU); // wrong → -1 life
        remainingAttempts = Math.max(remainingAttempts - 1, 0);
      }
    }
  } else if (guess.length === answer.length) {
    // Full word guess
    if (guess === answer) {
      won = true;
      points = Math.max(hangmanCfg.points.victoryBase - (attemptNumber - 1) * penalty, 0);
      answer.split('').forEach((ch) => guessedLetters.add(ch.toUpperCase()));
    } else {
      won = false;
      points = hangmanCfg.points.losePenalty;
      remainingAttempts = 0; // end immediately
    }
  } else {
    throw new Error(
      `Invalid guess length. Must be 1 letter or ${answer.length} letters for full word.`
    );
  }

  // Build word progress
  const wordProgress = answer
    .split('')
    .map((ch) => (guessedLetters.has(ch.toUpperCase()) ? ch.toUpperCase() : '?'))
    .join(' ');

  // Win if completed gradually
  if (!won && !wordProgress.includes('?')) {
    won = true;
    points = Math.max(hangmanCfg.points.victoryBase - (attemptNumber - 1) * penalty, 0);
  }

  // Lose if out of lives
  if (!won && remainingAttempts === 0) {
    won = false;
    if (points === 0) points = hangmanCfg.points.losePenalty;
  }

  const displayInfo = {
    wordProgress,
    guessedLetters: Array.from(guessedLetters),
    wrongLetters: Array.from(wrongLetters),
    remainingAttempts
  };

  await mongoChatterpointsService.pushPlayEntry(cycleId, periodId, req.userId, {
    guess,
    points,
    at: now,
    won,
    attemptNumber,
    displayInfo
  });

  return { status: 'ok', periodClosed: false, won, points, display_info: displayInfo };
}

// -------------------------------------------------------------------------------------------------------------

export const chatterpointsService = {
  /**
   * Creates a new game cycle with configured games and periods.
   *
   * - Validates that the requester has admin rights (`games_admin`).
   * - Ensures there is no currently open cycle; if one exists but is expired, it auto-closes it.
   * - Determines the cycle time range using either:
   *   - `req.startAt` + `req.durationMinutes`, or
   *   - `req.startAt` + `req.endAt`, or
   *   - Defaults to current time + `DEFAULTS.cycleDurationMinutes`.
   * - Builds default game configurations (`WORDLE`, `HANGMAN`) and merges with overrides from `req.games`.
   * - Performs business validation (e.g., Wordle word length must be integer between 5 and 15).
   * - Validates the relationship between cycle duration and period duration (`validatePeriodHierarchy`).
   * - Expands periods for each enabled game using `expandPeriodsForGame` and tracks used words.
   * - Persists the new cycle in MongoDB via `mongoChatterpointsService.createCycle`.
   *
   * @async
   * @function createCycle
   * @param {CreateCycleRequest} req - The request containing user ID, time settings, game configs, and podium prizes.
   * @returns {Promise<IChatterpointsDocument>} The newly created cycle document stored in MongoDB.
   *
   * @throws {Error} If:
   * - The user is not authorized (missing `userId` or not an admin).
   * - There is an already open cycle that has not yet expired.
   * - Game configuration validation fails (e.g., invalid Wordle word length).
   * - Period hierarchy validation fails (periods not shorter than cycle).
   *
   * @example
   * const cycle = await createCycle({
   *   userId: "admin1",
   *   durationMinutes: 1440, // 1 day
   *   games: [{ type: "WORDLE", gameId: "wordle", enabled: true }],
   *   podiumPrizes: [100, 50, 25]
   * });
   * console.log(cycle.startAt, cycle.endAt, cycle.games.length);
   */
  createCycle: async (req: CreateCycleRequest): Promise<IChatterpointsDocument> => {
    if (!req.userId) {
      throw new Error("You don't have access to this operation.");
    }

    const isAdmin = await mongoUserService.getUser(req.userId);
    if (!isAdmin?.games_admin) {
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

      // Business validation: WORDLE wordLength must be an integer in [5, 15]
      const settings = (merged.config as { settings?: { wordLength?: unknown } } | undefined)
        ?.settings;
      const wl = settings?.wordLength as number | undefined;
      if (wl !== undefined) {
        if (!Number.isInteger(wl) || wl < 5 || wl > 15) {
          throw new Error(
            `Invalid WORDLE settings.wordLength: ${wl}. Must be an integer between 5 and 15.`
          );
        }
      }

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

    const periodsPromises: Promise<GamePeriod[]>[] = games
      .filter((g) => g.enabled)
      .map(async (g) => {
        const ps = await expandPeriodsForGame(g, startAt, endAt);
        // Track used words in the config to prevent reuse across cycles (basic)
        g.usedWords.push(...ps.map((p) => p.word));
        return ps;
      });

    const allPeriodsArrays = await Promise.all(periodsPromises);
    const allPeriods: GamePeriod[] = allPeriodsArrays.flat();

    return mongoChatterpointsService.createCycle({
      startAt,
      endAt,
      games,
      periods: allPeriods,
      podiumPrizes: req.podiumPrizes ?? [0, 0, 0]
    });
  },

  /**
   * Handles the main game play flow for both Wordle and Hangman.
   *
   * - Ensures there is an open cycle; throws if none exists or if it is not `OPEN`.
   * - Resolves the currently active period for the given game.
   *   - If no active period exists, returns `periodClosed = true`.
   *   - If the active period has expired, closes it and returns `periodClosed = true`.
   * - Validates that the game is enabled and properly configured.
   * - Fetches the user state within the current period (attempts, win status).
   * - Enforces game-specific rules before play:
   *   - Wordle: prevents plays after the max attempts per period.
   *   - Hangman: prevents multiple plays or playing after winning.
   * - Prevents duplicate guesses in the same period.
   * - Delegates scoring and play resolution to the appropriate game logic:
   *   - `playWordle` for Wordle-specific scoring and feedback.
   *   - `playHangman` for Hangman-specific scoring and feedback.
   *
   * @async
   * @function play
   * @param {PlayRequest} req - The play request containing user ID, game ID, and guess.
   * @returns {Promise<{
   *   status: string;
   *   periodClosed: boolean;
   *   won: boolean;
   *   points: number;
   *   display_info?: Record<string, unknown>;
   * }>} The outcome of the play, including points and user-facing display info.
   *
   * @throws {Error} If:
   * - No cycle is open.
   * - Game is disabled or not configured.
   * - Guess violates validation rules (e.g., duplicate, length mismatch).
   *
   * @example
   * const result = await play({ userId: "u1", gameId: "wordle", guess: "apple" });
   * console.log(result.display_info?.message);
   */
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

    let cycle = await mongoChatterpointsService.getOpenCycle();
    if (!cycle || cycle.status !== 'OPEN') {
      Logger.debug('[play] no OPEN cycle found');
      return {
        status: 'ok',
        periodClosed: true,
        won: false,
        points: 0,
        display_info: { message: 'No active cycle is currently open.' }
      };
    }

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
    const active = await mongoChatterpointsService.getActivePeriod(cycleId, req.gameId, now);

    if (!active || !active.period) {
      Logger.debug('[play] no active period resolved for game=%s', req.gameId);
      return {
        status: 'ok',
        periodClosed: true,
        won: false,
        points: 0,
        display_info: { message: 'The current period has already concluded.' }
      };
    }

    const { cycle: refreshedCycle, period } = active;
    cycle = refreshedCycle;
    const { periodId } = period;

    Logger.debug(
      '[play] active period resolved periodId=%s startAt=%s endAt=%s status=%s',
      periodId,
      new Date(period.startAt).toISOString(),
      new Date(period.endAt).toISOString(),
      period.status
    );

    // 4) Game config
    const gameCfg = cycle.games.find((g) => g.gameId === req.gameId && g.enabled);
    if (!gameCfg) {
      Logger.debug('[play] game not configured or disabled gameId=%s', req.gameId);
      throw new Error('Game disabled or not configured');
    }
    Logger.debug('[play] gameCfg type=%s enabled=%s', gameCfg.type, gameCfg.enabled);

    const user = period.plays.find((u) => u.userId === req.userId);
    Logger.debug('[play] user state attempts=%s won=%s', user?.attempts ?? 0, user?.won ?? false);

    const attemptNumber = (user?.attempts ?? 0) + 1;

    // 5) Rules
    if (user?.won) {
      return {
        status: 'ok',
        periodClosed: false,
        won: true,
        points: 0,
        display_info: {
          message: 'You already guessed the word this period. Please wait for the next one.'
        }
      };
    }

    if (gameCfg.type === 'WORDLE') {
      const wordleCfg = gameCfg.config as Extract<GameSettings, { type: 'WORDLE' }>;
      const maxAttempts = wordleCfg.settings.attemptsPerUserPerPeriod;
      if ((user?.attempts ?? 0) >= maxAttempts) {
        return {
          status: 'ok',
          periodClosed: false,
          won: false,
          points: 0,
          display_info: { message: 'Max attempts reached for this period.' }
        };
      }
    } // hangman (verified en custom method)

    // 5b) Duplicate guess guard
    const normalizedGuess = req.guess.trim().toLowerCase();
    const alreadyTriedSame =
      user?.entries?.some((e) => e.guess.trim().toLowerCase() === normalizedGuess) ?? false;

    if (alreadyTriedSame) {
      Logger.debug(
        '[play] duplicate guess in the same period userId=%s guess=%s',
        req.userId,
        normalizedGuess
      );
      return {
        status: 'error',
        periodClosed: false,
        won: false,
        points: 0,
        display_info: {
          message:
            gameCfg.type === 'WORDLE'
              ? 'You already tried that word in this period. Try a different one.'
              : 'You already tried that letter in this period. Try a different one.'
        }
      };
    }

    // 6) Delegate to game-specific logic
    const userDoc = await mongoUserService.getUser(req.userId);
    const lang: gamesLanguage =
      (userDoc?.settings?.notifications?.language as gamesLanguage) ?? GAMES_LANGUAGE_DEFAULT;
    if (gameCfg.type === 'WORDLE') {
      return playWordle(cycleId, periodId, req, period, gameCfg, attemptNumber, now, lang);
    }
    return playHangman(cycleId, periodId, req, period, gameCfg, attemptNumber, now, lang);
  },

  /**
   * Registers a user’s social participation in the current game cycle.
   *
   * - Requires that there is an active `OPEN` cycle.
   * - If a `cycleId` is provided in the request, validates that the cycle exists and is `OPEN`.
   * - If no `cycleId` is provided, resolves automatically to the latest `OPEN` cycle.
   * - Records a social registration event with user ID, platform, and timestamp.
   *
   * @async
   * @function registerSocial
   * @param {SocialRequest} req - The request containing:
   *   - `userId`: The ID of the user registering social participation.
   *   - `platform`: The social platform (e.g., "twitter", "discord").
   *   - `cycleId?`: Optional. The cycle to register against; if omitted, the latest `OPEN` cycle is used.
   * @returns {Promise<{ granted: boolean }>} Whether the social registration was granted.
   *
   * @throws {Error} If:
   * - The provided cycle ID is invalid or not `OPEN`.
   * - No `OPEN` cycle exists when one is required.
   *
   * @example
   * const res = await registerSocial({ userId: "u123", platform: "twitter" });
   * console.log(res.granted); // → true or false
   */
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

  /**
   * Retrieves gameplay statistics for a given user in a specific cycle.
   *
   * - Resolves the cycle to use:
   *   - If `cycleId` is provided in the request, loads that cycle.
   *   - Otherwise, falls back to the most recent cycle (`getLastCycle`).
   * - Computes:
   *   - Total points accumulated by the user in the cycle.
   *   - Number of periods played.
   *   - Number of wins.
   * - Determines the relevant period to display:
   *   - Prefers the currently active (OPEN) period that includes "now".
   *   - If none are active, uses the most recent period by `endAt`.
   * - Builds a `periodRange` string (ISO timestamps).
   * - Resolves the user’s display label with `getDisplayUserLabel`.
   *
   * @async
   * @function getStats
   * @param {StatsRequest} req - The request containing:
   *   - `userId`: The user for whom stats are retrieved.
   *   - `cycleId?`: Optional. Specific cycle to query; if omitted, the latest cycle is used.
   * @returns {Promise<{
   *   cycleId: string;
   *   periodId: string;
   *   periodRange: string;
   *   userId: string;
   *   userProfile: string;
   *   totalPoints: number;
   *   periodsPlayed: number;
   *   wins: number;
   * }>} A stats object containing user totals and the relevant period.
   *
   * @example
   * const stats = await getStats({ userId: "u123" });
   * console.log(stats.totalPoints, stats.wins);
   *
   * @throws {Error} Only if underlying DB queries fail; otherwise gracefully returns zeroed stats.
   */
  getStats: async (
    req: StatsRequest
  ): Promise<{
    cycleId: string;
    periodId: string;
    periodRange: string;
    userId: string;
    userProfile: string;
    totalPoints: number;
    periodsPlayed: number;
    wins: number;
  }> => {
    // Minimal shapes expected from mongo (narrowed locally to satisfy typing & linter)
    type PeriodPlay = { userId: string; won: boolean };
    type Period = {
      periodId: string;
      startAt: Date;
      endAt: Date;
      status: 'OPEN' | 'CLOSED';
      plays: PeriodPlay[];
    };
    type TotalsByUser = { userId: string; points: number };
    type CycleDoc = {
      cycleId: string;
      startAt: Date;
      endAt: Date;
      periods: Period[];
      totalsByUser: TotalsByUser[];
    };

    // 1) Resolve cycleId (optional) → fall back to last cycle
    let { cycleId } = req;
    if (!cycleId) {
      const last = await mongoChatterpointsService.getLastCycle();
      if (!last) {
        return {
          cycleId: '',
          periodId: '',
          periodRange: '',
          userId: req.userId,
          userProfile: await getDisplayUserLabel(req.userId),
          totalPoints: 0,
          periodsPlayed: 0,
          wins: 0
        };
      }
      ({ cycleId } = last);
    }

    // 2) Load cycle document

    const cycle: CycleDoc | null = await mongoChatterpointsService.getCycleById(cycleId);
    if (!cycle) {
      return {
        cycleId,
        periodId: '',
        periodRange: '',
        userId: req.userId,
        userProfile: await getDisplayUserLabel(req.userId),
        totalPoints: 0,
        periodsPlayed: 0,
        wins: 0
      };
    }

    // 3) Compute user totals
    const totalPoints: number =
      cycle.totalsByUser.find((t: TotalsByUser) => t.userId === req.userId)?.points ?? 0;

    const agg = cycle.periods.reduce<{ periodsPlayed: number; wins: number }>(
      (acc, p: Period) => {
        const u: PeriodPlay | undefined = p.plays.find((x: PeriodPlay) => x.userId === req.userId);
        if (u) {
          acc.periodsPlayed += 1;
          acc.wins += u.won ? 1 : 0;
        }
        return acc;
      },
      { periodsPlayed: 0, wins: 0 }
    );

    // 4) Determine period range to display:
    //    prefer the active (OPEN) period that contains "now"; otherwise, the most recent by endAt.
    const now: number = Date.now();
    const active: Period | undefined = cycle.periods.find(
      (p: Period) =>
        p.status === 'OPEN' &&
        p.startAt instanceof Date &&
        p.endAt instanceof Date &&
        p.startAt.getTime() <= now &&
        now < p.endAt.getTime()
    );

    // Pick most recent (by endAt) if there is no active period
    const mostRecent: Period | undefined =
      active ??
      cycle.periods
        .slice()
        .sort((a: Period, b: Period) => b.endAt.getTime() - a.endAt.getTime())[0];

    const formatRange = (start: Date, end: Date): string =>
      `${start.toISOString()} - ${end.toISOString()}`;

    const periodRange: string =
      mostRecent && mostRecent.startAt instanceof Date && mostRecent.endAt instanceof Date
        ? formatRange(mostRecent.startAt, mostRecent.endAt)
        : '';

    // 5) Resolve display label
    const userProfile: string = await getDisplayUserLabel(req.userId);

    // 6) Return payload
    return {
      cycleId,
      periodId: mostRecent.periodId,
      periodRange,
      userId: req.userId,
      userProfile,
      totalPoints,
      periodsPlayed: agg.periodsPlayed,
      wins: agg.wins
    };
  },

  /**
   * Retrieves the leaderboard for a given cycle.
   *
   * - Resolves the target cycle:
   *   - If `req.cycleId` is provided, fetches that cycle.
   *   - Otherwise, falls back to the last available cycle (open or closed).
   * - Determines how many top entries to fetch (defaults to 3 if `req.top` is not a valid number).
   * - Queries MongoDB for leaderboard results (`getLeaderboardTop`).
   * - Resolves display labels for all unique user IDs via `getDisplayUserLabel`.
   * - Maps leaderboard positions to trophies:
   *   - 🥇 for 1st
   *   - 🥈 for 2nd
   *   - 🥉 for 3rd
   * - Builds the final leaderboard entries including position, user, points, and prize.
   * - Returns the cycle ID, cycle date range, and formatted entries.
   *
   * @async
   * @function getLeaderboard
   * @param {LeaderboardRequest} req - The request containing:
   *   - `cycleId?`: Optional cycle to query; if omitted, uses the most recent cycle.
   *   - `top?`: Number of top entries to return (defaults to 3).
   * @returns {Promise<LeaderboardResult>} The leaderboard result including cycle info and entries.
   *
   * @example
   * const leaderboard = await getLeaderboard({ top: 5 });
   * console.log(leaderboard.entries);
   *
   * @throws {Error} Only if underlying DB queries fail; otherwise returns an empty leaderboard.
   */
  getLeaderboard: async (req: LeaderboardRequest): Promise<LeaderboardResult> => {
    // 1) Resolve target cycle safely (default top = 3)
    const top: number = typeof req.top === 'number' && req.top > 0 ? req.top : 3;

    let targetCycleId: string | undefined = req.cycleId;

    // If no cycleId provided, try to find the last cycle (open or closed)
    if (!targetCycleId) {
      const lastCycle = await mongoChatterpointsService.getLastCycle();
      if (!lastCycle) {
        return { cycleId: '', cycleRange: '', entries: [] };
      }
      targetCycleId = lastCycle.cycleId;
    }

    // 2) Fetch leaderboard from mongo (shape: { cycle: {cycleId, startAt, endAt}, items: LeaderboardItem[] })
    const leaderboard: LeaderboardResponse | null =
      await mongoChatterpointsService.getLeaderboardTop(targetCycleId, top);

    if (!leaderboard) {
      return { cycleId: targetCycleId, cycleRange: '', entries: [] };
    }

    const {
      cycle: { cycleId, startAt, endAt },
      items
    } = leaderboard;

    // 3) Build user labels map with strict typing
    const uniqueIds: string[] = Array.from(new Set(items.map((r: LeaderboardItem) => r.userId)));

    const idLabelPairs: Array<[string, string]> = await Promise.all(
      uniqueIds.map<Promise<[string, string]>>(async (id: string) => [
        id,
        await getDisplayUserLabel(id)
      ])
    );

    const byId: Map<string, string> = new Map<string, string>(idLabelPairs);
    const displayUser = (id: string): string => byId.get(id) ?? id;

    // 4) Trophy mapping
    const trophyFor = (pos: number): string | undefined => {
      const trophies: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };
      return trophies[pos];
    };

    // 5) Cycle range for user display
    const cycleRange: string = `${startAt.toISOString()} - ${endAt.toISOString()}`;

    // 6) Map mongo items to view rows
    const rows: LeaderboardRow[] = items.map<LeaderboardRow>((r: LeaderboardItem, idx: number) => ({
      position: idx + 1,
      trophy: trophyFor(idx + 1),
      user: displayUser(r.userId),
      points: r.points,
      prize: r.prize
    }));

    // 7) Final payload
    return {
      cycleId,
      cycleRange,
      entries: rows
    };
  },

  /**
   * Get metadata about the current cycle games.
   *
   * - Resolves the currently OPEN cycle (or last one if none open).
   * - Returns:
   *   - Cycle start and end dates.
   *   - Enabled games with their IDs, types, and word length setting.
   *   - Periods with their IDs, start/end dates, and gameId.
   * - Does NOT expose sensitive fields such as:
   *   - Secret words
   *   - User plays or guesses
   *   - Any scoring data
   *
   * @async
   * @function getCycleGamesInfo
   * @returns {Promise<{
   *   cycleId: string;
   *   startAt: Date;
   *   endAt: Date;
   *   games: Array<{ gameId: string; type: GameType; wordLength: number }>;
   *   periods: Array<{ periodId: string; gameId: string; startAt: Date; endAt: Date }>;
   * }>}
   * @throws {Error} If no cycle is found.
   */
  getCycleGamesInfo: async (): Promise<{
    cycleId: string;
    status: CycleStatus;
    startAt: Date;
    endAt: Date;
    games: Array<{ gameId: string; type: GameType; wordLength: number }>;
    periods: Array<{
      periodId: string;
      gameId: string;
      startAt: Date;
      endAt: Date;
      status: PeriodStatus;
    }>;
  }> => {
    const cycle = await mongoChatterpointsService.getOpenCycle();
    if (!cycle) {
      throw new Error('No OPEN cycle found');
    }

    const games = cycle.games
      .filter((g) => g.enabled)
      .map((g) => {
        const wordLength =
          g.type === 'WORDLE'
            ? (g.config as Extract<GameSettings, { type: 'WORDLE' }>).settings.wordLength
            : (g.config as Extract<GameSettings, { type: 'HANGMAN' }>).settings.wordLength;
        return { gameId: g.gameId, type: g.type, wordLength };
      });

    const periods = cycle.periods.map((p) => ({
      periodId: p.periodId,
      gameId: p.gameId,
      startAt: p.startAt,
      endAt: p.endAt,
      status: p.status
    }));

    return {
      cycleId: cycle.cycleId,
      status: cycle.status,
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      games,
      periods
    };
  },

  /**
   * Perform maintenance: close expired and open upcoming periods.
   *
   * @returns {Promise<{ closedPeriods: number; closedCycles: number; openedPeriods: number }>}
   */
  maintainPeriodsAndCycles: async (): Promise<{
    closedPeriods: number;
    closedCycles: number;
    openedPeriods: number;
  }> => {
    Logger.debug('[chatterpointsService.maintainPeriodsAndCycles] job started');

    const closed = await mongoChatterpointsService.closeExpiredPeriodsAndCycles();
    const opened = await mongoChatterpointsService.openUpcomingPeriods();

    Logger.info(
      '[chatterpointsService.maintainPeriodsAndCycles] job finished closedPeriods=%d closedCycles=%d openedPeriods=%d',
      closed.closedPeriods,
      closed.closedCycles,
      opened.openedPeriods
    );

    return { ...closed, openedPeriods: opened.openedPeriods };
  },

  /**
   * Retrieve all play entries for a given cycle.
   *
   * Responsibilities:
   * - If `cycleId` is provided, fetch that cycle.
   * - If not provided, falls back to the last cycle (open or closed).
   * - If `userId` is provided, filters plays for that user only.
   * - Formats each play entry as a single-line string for easy reading.
   * - Orders plays from most recent to oldest.
   *
   * @param {Object} opts Options for filtering.
   * @param {string} [opts.cycleId] Optional cycleId. If omitted, the last cycle is used.
   * @param {string} [opts.userId] Optional userId. If provided, only this user's plays are returned.
   * @returns {Promise<{
   *   cycleId: string;
   *   startAt: Date;
   *   endAt: Date;
   *   status: string;
   *   plays: string[];
   * } | null>} Cycle metadata and play lines, or null if no cycle found.
   */
  getCyclePlays: async (opts: {
    cycleId?: string;
    userId?: string;
  }): Promise<{
    cycleId: string;
    startAt: Date;
    endAt: Date;
    status: string;
    plays: string[];
  } | null> => {
    let cycle: IChatterpointsDocument | null = null;

    if (opts.cycleId) {
      cycle = await mongoChatterpointsService.getCycleById(opts.cycleId);
    } else {
      cycle = await mongoChatterpointsService.getLastCycle();
    }

    if (!cycle) {
      return null;
    }

    const plays: string[] = cycle.periods
      .flatMap((period: GamePeriod) =>
        period.plays
          .filter((play: PeriodUserPlays) => {
            if (opts.userId) {
              return play.userId === opts.userId;
            }
            return true;
          })
          .flatMap((play: PeriodUserPlays) =>
            play.entries.map((entry: PlayAttempt) => {
              const result = entry.result ?? '';
              const attemptsInfo = `${play.attempts}`;

              return (
                `${play.userId}, ${entry.at.toISOString()}, ${period.gameId}, ` +
                `guess: ${entry.guess}, result: ${result}, points: ${entry.points}, ` +
                `attempts: ${attemptsInfo}, period: ${period.periodId}`
              );
            })
          )
      )
      .sort((a, b) => {
        const dateA = new Date(a.split(',')[1].trim()).getTime();
        const dateB = new Date(b.split(',')[1].trim()).getTime();
        return dateB - dateA;
      });

    return {
      cycleId: cycle.cycleId,
      startAt: cycle.startAt,
      endAt: cycle.endAt,
      status: cycle.status,
      plays
    };
  }
};
