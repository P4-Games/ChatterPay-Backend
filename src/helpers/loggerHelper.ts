import pino from 'pino';
import pinoPretty from 'pino-pretty';

import { LogLevelType, validLogLevels } from '../types/logger';
import { IS_DEVELOPMENT, CURRENT_LOG_LEVEL } from '../config/constants';

// Create a pretty stream for local console output with colorized logs
const prettyStream = pinoPretty({
  // Enables color output for logs in the console,
  colorize: true,
  // Logs are written synchronously to ensure immediate delivery
  sync: true,
  translateTime: 'SYS:standard',
  ignore: 'hostname,pid'
});

// Create a stream for Google Cloud Logging, writing to 'stdout' (standard
// output). Here, you can configure it further to work with Google Cloud
// Logging specifically.
const cloudStream2 = pino.destination({
  // Avoid errors caused by ANSI characters when using pinoPretty for coloring
  colorize: false,
  // Ensures logs are written immediately
  sync: true
});

const selectedStream = !IS_DEVELOPMENT ? prettyStream : cloudStream2;
// Create a logger instance using pino with multiple streams
const logger = pino(
  {
    // Sets the minimum log level
    level: CURRENT_LOG_LEVEL,
    formatters: {
      level(label) {
        // Keep the level as part of the log in the JSON format
        return { level: label };
      }
    }
  },
  selectedStream
);

export class Logger {
  private static logMessage(level: LogLevelType, method: string, ...args: unknown[]): void {
    try {
      // Construye el mensaje como un string unificado
      const message = args
        .map((arg) =>
          typeof arg === 'string' ? arg.replace(/(\r\n|\n|\r)/g, ' ') : JSON.stringify(arg)
        )
        .join(';');

      /*
      const cleanedMessage = args
        .map((arg) => (typeof arg === 'string' ? arg.replace(/(\r\n|\n|\r)/g, ' ') : String(arg)))
        .join(' ');
      */

      logger[level]({ method, msg: message });
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

  static trace(method: string = 'trace', ...args: unknown[]): void {
    if (this.shouldLog('trace')) {
      this.logMessage('trace', method, ...args);
    }
  }

  static log(method: string = 'debug', ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.logMessage('debug', method, ...args);
    }
  }

  static debug(method: string = 'debug', ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      this.logMessage('debug', method, ...args);
    }
  }

  static info(method: string = 'info', ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      this.logMessage('info', method, ...args);
    }
  }

  static warn(method: string = 'warn', ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      this.logMessage('warn', method, ...args);
    }
  }

  static error(method: string = 'error', ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      this.logMessage('error', method, ...args);
    }
  }

  static fatal(method: string = 'unknown', ...args: unknown[]): void {
    if (this.shouldLog('fatal')) {
      this.logMessage('fatal', method, ...args);
    }
  }
}
