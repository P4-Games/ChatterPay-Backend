import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Set up test environment variables
process.env.ALCHEMY_SIGNING_KEY = 'test-signing-key-for-testing';
process.env.DEFAULT_CHAIN_ID = '421614';
process.env.DEPOSITS_PROVIDER = 'alchemy';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create({
    binary: {
      downloadDir: '/tmp/mongodb-binaries',
      version: '7.0.14'
    }
  });
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});
