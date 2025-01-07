// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LogMethodType = (...args: any[]) => void;

export type LogLevelType = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const validLogLevels = Object.values({
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal'
}) as LogLevelType[];
