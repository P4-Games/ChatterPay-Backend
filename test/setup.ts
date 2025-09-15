/**
 * Test setup file
 */

// Set up test environment variables
process.env.ALCHEMY_SIGNING_KEY = 'test-signing-key-for-testing';
process.env.MONGO_URI = 'mongodb://localhost:27017/chatterpay-test';
process.env.DEFAULT_CHAIN_ID = '421614';
process.env.DEPOSITS_PROVIDER = 'alchemy';

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: () => {},
  info: () => {},
  warn: () => {},
  debug: () => {},
};
