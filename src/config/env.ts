import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4027),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  // Exactly one topology is implemented: a private service behind a trusted BFF/gateway.
  AUTH_MODE: z.literal('bff_internal').default('bff_internal'),
  INTERNAL_SERVICE_TOKEN: z.string().min(16, 'INTERNAL_SERVICE_TOKEN must be at least 16 characters'),
  // stub = local-development adapters; http = real Document/Publishing services (contracts not yet confirmed).
  INTEGRATIONS_MODE: z.enum(['stub', 'http']).default('stub'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(1000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(60000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (/change|replace|example/i.test(cfg.INTERNAL_SERVICE_TOKEN)) {
      throw new Error('Invalid configuration: INTERNAL_SERVICE_TOKEN is still a placeholder');
    }
    if (cfg.INTEGRATIONS_MODE === 'stub') {
      throw new Error('Invalid configuration: INTEGRATIONS_MODE=stub is not allowed in production');
    }
  }
  return cfg;
}
