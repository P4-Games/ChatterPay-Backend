import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../src/helpers/loggerHelper', () => ({
  Logger: {
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn()
  }
}));

// Load environment variables from .env
dotenv.config();

// Fix the Alchemy signing key for deterministic HMAC verification during tests.
// This ensures that the generated signatures and the verification logic use the same
// known secret key, avoiding mismatches with real environment values.
process.env.ALCHEMY_SIGNING_KEY = 'test-signing-key-for-testing';
process.env.SECURITY_PIN_HMAC_KEY = 'test-security-hmac-key';
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

beforeAll(async () => {
  try {
    const uri = process.env.MONGO_MEMORY_SERVER_URI;
    if (!uri) throw new Error('MongoDB Memory Server URI not available');

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri);
    }
  } catch (error) {
    console.error('Failed to start MongoDB Memory Server:', error);
    throw error;
  }
}, 120000); // Increase timeout to 120 seconds for MongoDB startup

beforeEach(async () => {
  if (mongoose.connection.readyState !== 1) return;
  const collections = mongoose.connection.collections;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
});
