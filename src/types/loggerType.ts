// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LogMethod = (...args: any[]) => void;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const validLogLevels = Object.values({
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal'
}) as LogLevel[];
