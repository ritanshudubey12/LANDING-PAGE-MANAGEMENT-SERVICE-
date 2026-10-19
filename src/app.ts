import express from 'express';
import type { Pool } from 'pg';
import type { Config } from './config/env';
import { createController } from './controllers/landing-page.controller';
import type { Integrations } from './integrations/clients';
import type { Logger } from './lib/logger';
import { authenticate } from './middleware/authenticate';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { rateLimit } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { trustedContext } from './middleware/trusted-context';
import { landingPageRoutes } from './routes/landing-page.routes';
import { LandingPageService } from './services/landing-page.service';

export type AppDeps = { config: Config; pool: Pool; integrations: Integrations; logger: Logger };

export function createApp({ config, pool, integrations, logger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info('request', {
        requestId: res.locals.requestId,
        method: req.method,
        route: req.baseUrl + (req.route?.path ?? req.path),
        status: res.statusCode,
        latencyMs: Number(process.hrtime.bigint() - start) / 1e6,
      });
    });
    next();
  });
  app.use(rateLimit(config.RATE_LIMIT_PER_MINUTE));

  // Unauthenticated operational endpoints (no tenant data).
  app.get('/health', (_req, res) => {
    res.status(200).json({ success: true, data: { status: 'ok' }, requestId: res.locals.requestId });
  });
  app.get('/ready', async (_req, res) => {
    const checks = { database: false, integrations: false };
    try {
      await pool.query('SELECT 1');
      checks.database = true;
    } catch {
      /* reported via checks */
    }
    try {
      checks.integrations = await integrations.ready();
    } catch {
      /* reported via checks */
    }
    const ready = checks.database && checks.integrations;
    res.status(ready ? 200 : 503).json({ success: ready, data: { status: ready ? 'ready' : 'not_ready', checks }, requestId: res.locals.requestId });
  });

  const service = new LandingPageService(pool, integrations, logger);
  const api = express.Router();
  api.use(authenticate(config.INTERNAL_SERVICE_TOKEN));
  api.use(trustedContext);
  api.use(express.json({ limit: '100kb' }));
  api.use(landingPageRoutes(createController(service), logger));
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
