import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';
import { env } from './config.js';

export type { Logger } from 'pino';

/**
 * Structured JSON logging, trace-correlated: every line carries trace_id /
 * span_id when emitted inside an active span, so logs join traces without
 * grep archaeology. Level is env-tunable (ACP_LOG_LEVEL).
 */
export function createLogger(serviceName: string): Logger {
  return pino({
    name: serviceName,
    level: env('ACP_LOG_LEVEL', 'info'),
    messageKey: 'message',
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      // Tokens and credentials never reach the log sink, even at debug.
      paths: [
        '*.authorization',
        '*.token',
        '*.subject_token',
        '*.delegated_token',
        '*.password',
        'req.headers.authorization',
      ],
      censor: '[redacted]',
    },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
  });
}
