import { Pool } from 'pg';
import type { Config } from '../config/env';

export function createPool(cfg: Config): Pool {
  return new Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DB_POOL_MAX,
    connectionTimeoutMillis: cfg.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: cfg.DB_IDLE_TIMEOUT_MS,
  });
}
