import pino from 'pino';
import pinoPretty from 'pino-pretty';

import { LogLevel, validLogLevels } from '../types/logger';
import { CURRENT_LOG_LEVEL } from '../constants/environment';

const prettyStream = pinoPretty({
  colorize: true
});

const logger = pino(
  {
    level: 'debug'
  },
  prettyStream
);

export class Logger {
  private static logMessage(level: LogLevel, ...args: unknown[]): void {
    try {
      const cleanedMessage = args
        .map((arg) => (typeof arg === 'string' ? arg.replace(/(\r\n|\n|\r)/g, ' ') : String(arg)))
        .join(' ');

      logger[level](`${cleanedMessage}`);
    } catch (error: unknown) {
      const messageError = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Logger: Error trying to log Message: ${messageError}`);
    }
  }

  private static shouldLog(level: LogLevel): boolean {
    const currentLevelIndex = validLogLevels.indexOf(CURRENT_LOG_LEVEL);
    const messageLevelIndex = validLogLevels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  static trace(...args: unknown[]): void {
    if (this.shouldLog('trace')) {
      this.logMessage('trace', ...args);
    }
  }

  static log(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.logMessage('debug', ...args);
    }
  }

  static debug(...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.logMessage('debug', ...args);
    }
  }

  static info(...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.logMessage('info', ...args);
    }
  }

  static warn(...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.logMessage('warn', ...args);
    }
  }

  static error(...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.logMessage('error', ...args);
    }
  }

  static fatal(...args: unknown[]): void {
    if (this.shouldLog('fatal')) {
      this.logMessage('fatal', ...args);
    }
  }
}
