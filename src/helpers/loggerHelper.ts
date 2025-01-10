import pino from 'pino';
import pinoPretty from 'pino-pretty';

import { LogLevelType, validLogLevels } from '../types/logger';
import { IS_DEVELOPMENT, CURRENT_LOG_LEVEL } from '../config/constants';

// Create a pretty stream for local console output with colorized logs
const prettyStream = pinoPretty({
  colorize: true, // Enables color output for logs in the console,
  // Logs are written synchronously to ensure immediate delivery
  sync: true
});

// Create a stream for Google Cloud Logging, writing to 'stdout' (standard
// output). Here, you can configure it further to work with Google Cloud
// Logging specifically.
const cloudStream = pino.destination({
  // Avoid errors caused by ANSI characters when using pinoPretty for coloring
  colorize: false,
  // Logs are written to 'stdout' for Google Cloud consumption
  dest: 'stdout',
  // Logs are written synchronously to ensure immediate delivery
  sync: true
});

const selectedStream = IS_DEVELOPMENT ? prettyStream : cloudStream;
// Create a logger instance using pino with multiple streams
const logger = pino(
  {
    // Sets the minimum log level to 'debug'
    level: CURRENT_LOG_LEVEL
  },
  selectedStream
);

export class Logger {
  private static logMessage(level: LogLevelType, ...args: unknown[]): void {
    try {
      const cleanedMessage = args
        .map((arg) => (typeof arg === 'string' ? arg.replace(/(\r\n|\n|\r)/g, ' ') : String(arg)))
        .join(' ');
      logger[level](cleanedMessage);
    } catch (error: unknown) {
      const messageError = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Logger: Error trying to log Message: ${messageError}`);
    }
  }

  private static shouldLog(level: LogLevelType): boolean {
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
