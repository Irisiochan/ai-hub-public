import pino, { type Logger } from 'pino';

export type HubLogger = Logger;

export function createLogger(): HubLogger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'ai-hub' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.apiKey'],
      censor: '[REDACTED]',
    },
  });
}

export function logMessage(logger: HubLogger, component: string): (message: string) => void {
  return (message) => logger.info({ component }, message);
}
