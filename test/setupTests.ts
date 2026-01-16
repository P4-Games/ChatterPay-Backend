import dotenv from 'dotenv';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll } from 'vitest';

// Load environment variables from .env
dotenv.config();

// Fix the Alchemy signing key for deterministic HMAC verification during tests.
// This ensures that the generated signatures and the verification logic use the same
// known secret key, avoiding mismatches with real environment values.
process.env.ALCHEMY_SIGNING_KEY = 'test-signing-key-for-testing';
process.env.SECURITY_HMAC_KEY = 'test-security-hmac-key';
// Force SECURITY_PIN_ENABLED to true for tests (the tests expect PIN validation to be active)
process.env.SECURITY_PIN_ENABLED = 'true';

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
  try {
    mongoServer = await MongoMemoryServer.create({
      binary: {
        version: '7.0.14'
      },
      instance: {
        storageEngine: 'wiredTiger'
      }
    });
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
    console.log('MongoDB Memory Server started successfully');
  } catch (error) {
    console.error('Failed to start MongoDB Memory Server:', error);
    throw error;
  }
}, 120000); // Increase timeout to 120 seconds for MongoDB startup

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});
