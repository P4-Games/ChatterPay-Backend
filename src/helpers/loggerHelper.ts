import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { CURRENT_LOG_LEVEL, IS_DEVELOPMENT } from '../config/constants';
import { type LogLevel, validLogLevels } from '../types/loggerType';

// Create a pretty stream for local console output with colorized logs
const prettyStream = pinoPretty({
  // Enables color output for logs in the console,
  colorize: true,
  // Logs are written synchronously to ensure immediate delivery (just in local!)
  sync: true,
  translateTime: 'SYS:standard',
  ignore: 'hostname,pid'
});

// Create a stream for Google Cloud Logging, writing to 'stdout' (standard
// output). Here, you can configure it further to work with Google Cloud
// Logging specifically.
const cloudStream = pino.destination({
  // Avoid errors caused by ANSI characters when using pinoPretty for coloring
  colorize: false,
  // Avoid write delays in cloud environments
  sync: false
});

const selectedStream = IS_DEVELOPMENT ? prettyStream : cloudStream;
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
  private static formatArg(arg: unknown): string {
    if (typeof arg === 'string') {
      return arg.replace(/(\r\n|\n|\r)/g, ' ');
    }

    if (arg instanceof Error) {
      const anyErr = arg as Error & Record<string, unknown>;
      const payload: Record<string, unknown> = {
        name: anyErr.name,
        message: anyErr.message
      };

      // Common metadata (ethers/axios/etc.)
      const extraKeys = ['code', 'reason', 'method', 'data', 'error', 'stack'];
      extraKeys.forEach((key) => {
        if (anyErr[key] !== undefined) {
          payload[key] = anyErr[key];
        }
      });

      return JSON.stringify(payload).replace(/(\r\n|\n|\r)/g, ' ');
    }

    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg).replace(/(\r\n|\n|\r)/g, ' ');
      } catch {
        return '[Unserializable Object]';
      }
    }

    return String(arg);
  }

  private static logMessage(level: LogLevel, method: string, ...args: unknown[]): void {
    try {
      const message = args.map((arg) => Logger.formatArg(arg)).join(' ');

      const finalMessage = IS_DEVELOPMENT
        ? { msg: `[${method}], ${message}` }
        : { method, msg: message };
      logger[level](finalMessage);
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

  static trace(method: string = 'trace', ...args: unknown[]): void {
    if (Logger.shouldLog('trace')) {
      Logger.logMessage('trace', method, ...args);
    }
  }

  static log(method: string = 'debug', ...args: unknown[]): void {
    if (Logger.shouldLog('debug')) {
      Logger.logMessage('debug', method, ...args);
    }
  }

  static debug(method: string = 'debug', ...args: unknown[]): void {
    if (Logger.shouldLog('debug')) {
      Logger.logMessage('debug', method, ...args);
    }
  }

  static info(method: string = 'info', ...args: unknown[]): void {
    if (Logger.shouldLog('info')) {
      Logger.logMessage('info', method, ...args);
    }
  }

  static warn(method: string = 'warn', ...args: unknown[]): void {
    if (Logger.shouldLog('warn')) {
      Logger.logMessage('warn', method, ...args);
    }
  }

  static error(method: string = 'error', ...args: unknown[]): void {
    if (Logger.shouldLog('error')) {
      Logger.logMessage('error', method, ...args);
    }
  }

  static fatal(method: string = 'unknown', ...args: unknown[]): void {
    if (Logger.shouldLog('fatal')) {
      Logger.logMessage('fatal', method, ...args);
    }
  }
}
