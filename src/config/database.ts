import mongoose from 'mongoose';
import { Logger } from '../helpers/loggerHelper';
import { MONGO_URI } from './constants';

/** Wait between connection retries, growing up to MAX_RETRY_DELAY_MS. */
const INITIAL_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * How long mongoose waits for a server to be selected before giving up on a
 * single attempt. Kept well under Cloud Run's startup probe budget so a slow
 * cluster surfaces as a retry instead of a hung boot.
 */
const SERVER_SELECTION_TIMEOUT_MS = 10_000;

/**
 * Whether the database connection is currently usable.
 * @returns {boolean} True when mongoose reports an established connection
 */
export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Connects to the MongoDB database using the provided URI or a default local URI.
 * @returns {Promise<void>} Resolves once the connection is established or throws an error if the connection fails
 */
export async function connectToDatabase(): Promise<void> {
  Logger.info('connectToDatabase', 'Connecting to database');
  const MongoURI: string = MONGO_URI ?? 'mongodb://localhost:27017/chatterpay';
  try {
    await mongoose.connect(MongoURI, {
      serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS
    });
    Logger.info('connectToDatabase', 'MongoDB connected');
  } catch (error) {
    Logger.error('connectToDatabase', 'Failed to connect to MongoDB:', error);
    throw error;
  }
}

/**
 * Connects to MongoDB in the background, retrying with exponential backoff.
 *
 * The server binds its port before this resolves, so a slow or briefly
 * unreachable cluster delays queries instead of killing the container during
 * Cloud Run's startup probe. Mongoose buffers commands issued while the
 * connection is pending, and reconnects on its own once connected.
 *
 * @returns {Promise<void>} Resolves once the connection is established
 */
export async function connectToDatabaseWithRetry(): Promise<void> {
  let delay: number = INITIAL_RETRY_DELAY_MS;
  let attempt: number = 0;

  while (!isDatabaseConnected()) {
    attempt += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await connectToDatabase();
      return;
    } catch {
      Logger.warn(
        'connectToDatabaseWithRetry',
        `MongoDB connection attempt ${attempt} failed, retrying in ${delay}ms`
      );
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
  }
}
