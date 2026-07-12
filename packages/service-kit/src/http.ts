import { fastify, type FastifyInstance } from 'fastify';
import { AuthError } from './auth.js';
import type { Logger } from './logger.js';

export interface HttpServerOptions {
  serviceName: string;
  logger: Logger;
}

/**
 * HTTP bootstrap shared by control-plane services: health endpoint and an
 * error handler that returns structured, operator-actionable errors while
 * never leaking stack traces to callers.
 */
export function createHttpServer(options: HttpServerOptions): FastifyInstance {
  // Services log through their own structured logger (createLogger); the
  // fastify-internal logger stays off to keep one log shape per service.
  const app = fastify({ logger: false });

  app.get('/healthz', () => ({ status: 'ok', service: options.serviceName }));

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AuthError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, status: error.statusCode } });
    }
    const err = error instanceof Error ? error : new Error(String(error));
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      options.logger.error({ err, path: request.url }, 'request failed');
      // 5xx details stay in the logs; callers get the correlation ID.
      return reply
        .status(status)
        .send({ error: { message: 'internal error', request_id: request.id, status } });
    }
    return reply.status(status).send({ error: { message: err.message, status } });
  });

  return app;
}
