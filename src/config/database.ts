import mongoose from 'mongoose';

import { Logger } from '../utils/logger';
import { MONGO_URI } from '../constants/environment';

/**
 * Connects to the MongoDB database using the provided URI or a default local URI.
 *
 * @throws {Error} If the connection to MongoDB fails
 */
export async function connectToDatabase(): Promise<void> {
  Logger.info('Connecting to database');
  const MongoURI: string = MONGO_URI ?? 'mongodb://localhost:27017/chatterpay';
  try {
    await mongoose.connect(MongoURI);
    Logger.info('MongoDB connected');
  } catch (error) {
    Logger.error('Failed to connect to MongoDB:', error);
    throw error;
  }
}
