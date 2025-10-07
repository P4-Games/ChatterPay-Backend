import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Load environment variables from .env
dotenv.config();

// Fix the Alchemy signing key for deterministic HMAC verification during tests.
// This ensures that the generated signatures and the verification logic use the same
// known secret key, avoiding mismatches with real environment values.
process.env.ALCHEMY_SIGNING_KEY = 'test-signing-key-for-testing';

// Silence logs to keep test output clean
global.console = {
  ...console,
  log: () => {},
  info: () => {},
  warn: () => {},
  debug: () => {}
};

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
