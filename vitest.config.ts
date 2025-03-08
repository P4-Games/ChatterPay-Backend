import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
