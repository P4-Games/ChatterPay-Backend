import { MongoMemoryServer } from 'mongodb-memory-server';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createMongoServerWithRetry(retries = 3): Promise<MongoMemoryServer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await MongoMemoryServer.create({
        binary: {
          version: '7.0.14'
        },
        instance: {
          storageEngine: 'wiredTiger'
        }
      });
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await wait(500 * attempt);
      }
    }
  }

  throw lastError;
}

export default async function globalSetup() {
  const mongoServer = await createMongoServerWithRetry(3);
  process.env.MONGO_MEMORY_SERVER_URI = mongoServer.getUri();

  return async () => {
    await mongoServer.stop();
  };
}
