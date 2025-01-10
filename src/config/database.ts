import mongoose from 'mongoose';

import { MONGO_URI } from './constants';
import { Logger } from '../helpers/loggerHelper';

/**
 * Connects to the MongoDB database using the provided URI or a default local URI.
 * @returns {Promise<void>} Resolves once the connection is established or throws an error if the connection fails
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
