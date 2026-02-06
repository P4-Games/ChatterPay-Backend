import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    globals: true,
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    dir: 'test',
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      all: true,
      exclude: [
        '**/node_modules/**',
        'test',
        '.vscode',
        '.doc',
        '.github',
        '.husky',
        'scripts',
        '**/dist/**'
      ]
    },
    hookTimeout: 30000,
    setupFiles: ['./test/setupTests.ts']
  }
});
