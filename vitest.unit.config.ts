import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    dir: 'test',
    exclude: ['**/node_modules/**', '**/dist/**'],
    hookTimeout: 30000
  }
});
