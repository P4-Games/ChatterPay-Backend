import mongoose from 'mongoose';
import { Logger } from '../helpers/loggerHelper';
import { MONGO_URI } from './constants';

/**
 * Connects to the MongoDB database using the provided URI or a default local URI.
 * @returns {Promise<void>} Resolves once the connection is established or throws an error if the connection fails
 */
export async function connectToDatabase(): Promise<void> {
  Logger.info('connectToDatabase', 'Connecting to database');
  const MongoURI: string = MONGO_URI ?? 'mongodb://localhost:27017/chatterpay';
  try {
    await mongoose.connect(MongoURI);
    Logger.info('connectToDatabase', 'MongoDB connected');
  } catch (error) {
    Logger.error('connectToDatabase', 'Failed to connect to MongoDB:', error);
    throw error;
  }
}
