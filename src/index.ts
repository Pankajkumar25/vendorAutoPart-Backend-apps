import { env, isProd } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase } from './config/db';
import { installProcessHandlers } from './middleware/error.middleware';
import { expireStalePendingOrders } from './services/order.service';
import app from './app';

/**
 * Process entrypoint (spec section 44).
 *
 * Boot order: install the last-resort process handlers, connect to Mongo (and
 * refuse to serve traffic if that fails), then start listening. A background
 * sweep releases stock held by abandoned unpaid orders so it returns to the
 * pool, and SIGTERM/SIGINT drain the server before the connection is closed.
 */

// How often to release stock from stale, never-paid PENDING orders.
const ORDER_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

async function bootstrap(): Promise<void> {
  installProcessHandlers();

  await connectDatabase();
  logger.info('[db] connected');

  const server = app.listen(env.PORT, () => {
    logger.info(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
    logger.info(`[server] API mounted at ${env.API_PREFIX}`);
    if (!isProd) logger.info(`[server] http://localhost:${env.PORT}${env.API_PREFIX}/health`);
  });

  const sweep = setInterval(() => {
    expireStalePendingOrders()
      .then((released) => {
        if (released > 0) logger.info(`[orders] expired ${released} stale pending order(s), stock released`);
      })
      .catch((err) => logger.error('[orders] expiry sweep failed', err));
  }, ORDER_SWEEP_INTERVAL_MS);
  // Never let the sweep timer keep the process alive on its own.
  sweep.unref();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[server] ${signal} received, shutting down gracefully`);
    clearInterval(sweep);
    server.close(() => {
      disconnectDatabase()
        .then(() => {
          logger.info('[server] shutdown complete');
          process.exit(0);
        })
        .catch(() => process.exit(1));
    });
    // If connections refuse to drain, do not hang forever.
    setTimeout(() => {
      logger.error('[server] forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('[server] failed to start', err);
  process.exit(1);
});
