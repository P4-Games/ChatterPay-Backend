import { LogLevel, LogMethod } from '../types/logger';

export class Logger {
  private static logMethod: Record<LogLevel, LogMethod> = {
    log: console.log.bind(console),
    debug: console.debug.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console)
  };

  static log(...args: unknown[]): void {
    Logger.logMethod.log(...args);
  }

  static debug(...args: unknown[]): void {
    Logger.logMethod.debug(...args);
  }

  static error(...args: unknown[]): void {
    Logger.logMethod.error(...args);
  }

  static info(...args: unknown[]): void {
    Logger.logMethod.info(...args);
  }

  static warn(...args: unknown[]): void {
    Logger.logMethod.warn(...args);
  }
}

// Usage example
Logger.log('This is a log message:', { key: 'value' });
Logger.debug('Debugging information:', [1, 2, 3]);
Logger.error('An error occurred:', new Error('Sample error'));
Logger.info('Some informational message');
Logger.warn('This is a warning message!');
