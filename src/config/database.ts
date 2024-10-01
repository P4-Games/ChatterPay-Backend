import mongoose from 'mongoose';

/**
 * Connects to the MongoDB database using the provided URI or a default local URI.
 *
 * @throws {Error} If the connection to MongoDB fails
 */
export async function connectToDatabase(): Promise<void> {
    console.debug('Connecting to database');
    console.debug('MONGO_URI: ', process.env.MONGO_URI);
    const MongoURI: string = process.env.MONGO_URI ?? 'mongodb://localhost:27017/chatterpay';
    console.debug('MongoURI: ', MongoURI);
    try {
        await mongoose.connect(MongoURI);
        console.log('MongoDB connected');
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        throw error;
    }
}
