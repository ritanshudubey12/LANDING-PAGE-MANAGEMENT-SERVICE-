import { createApp } from './app';
import { loadConfig } from './config/env';
import { createPool } from './database/pool';
import { createHttpIntegrations, createStubIntegrations } from './integrations/clients';
import { startReconciler } from './jobs/reconciliation.worker';
import { createLogger } from './lib/logger';

function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const pool = createPool(config);
  pool.on('error', (e) => logger.error('pg_pool_error', { error: e.message }));

  const integrations = config.INTEGRATIONS_MODE === 'stub' ? createStubIntegrations(pool) : createHttpIntegrations();
  if (config.INTEGRATIONS_MODE === 'stub') logger.warn('integrations_stub_mode', { note: 'local-development adapters in use' });

  const app = createApp({ config, pool, integrations, logger });
  const server = app.listen(config.PORT, () => logger.info('listening', { port: config.PORT, env: config.NODE_ENV }));
  server.requestTimeout = config.REQUEST_TIMEOUT_MS;
  const stopReconciler = startReconciler(pool, integrations, logger, config.RECONCILE_INTERVAL_MS);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info('shutdown_started', { signal });
    stopReconciler();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(() => {
      pool.end().finally(() => {
        logger.info('shutdown_complete');
        process.exit(0);
      });
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

try {
  main();
} catch (e) {
  // Configuration errors must not leak values; the message names only the offending keys.
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
