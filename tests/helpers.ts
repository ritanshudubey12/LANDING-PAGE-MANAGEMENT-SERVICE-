import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config/env';
import { createPool } from '../src/database/pool';
import { migrate } from '../src/database/migrate';
import { createStubIntegrations, type Integrations } from '../src/integrations/clients';
import { createLogger } from '../src/lib/logger';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set (see .env.example)`);
  return v;
}

// The in-process test app uses its own throwaway token; it is unrelated to the real service credential.
export const TOKEN = 'test-internal-token-0123456789';
export const ALL_PERMS = [
  'landing-page:create',
  'landing-page:read',
  'landing-page:update',
  'landing-page:duplicate',
  'landing-page:delete',
  'landing-page:publish',
].join(',');

/**
 * Tests run against a dedicated `<db>_test` database so they never write into the development database
 * that the running service and the Postman collection use. It is created on first use.
 */
let testDbUrl: Promise<string> | undefined;
function ensureTestDatabase(): Promise<string> {
  testDbUrl ??= (async () => {
    const admin = new URL(requireEnv('DATABASE_URL'));
    const testName = `${admin.pathname.slice(1)}_test`;
    const pool = new Pool({ connectionString: admin.toString() });
    try {
      const exists = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [testName]);
      if (exists.rowCount === 0) {
        try {
          await pool.query(`CREATE DATABASE "${testName}"`);
        } catch (e) {
          if ((e as { code?: string }).code !== '42P04') throw e; // created concurrently by another worker
        }
      }
    } finally {
      await pool.end();
    }
    admin.pathname = `/${testName}`;
    return admin.toString();
  })();
  return testDbUrl;
}

export async function buildTestApp(override?: (i: Integrations) => Integrations) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: await ensureTestDatabase(),
    INTERNAL_SERVICE_TOKEN: TOKEN,
    LOG_LEVEL: 'error',
  } as NodeJS.ProcessEnv);
  const pool = createPool(config);
  await migrate(pool, 'up');
  const base = createStubIntegrations(pool);
  const integrations = override ? override(base) : base;
  const app = createApp({ config, pool, integrations, logger: createLogger('error', () => undefined) });
  return { app, pool, integrations };
}

/** Each test gets its own tenant/org so runs never collide, even on a shared database. */
export function newScope() {
  return {
    tenant: String(randomInt(1_000_000, 900_000_000)),
    org: String(randomInt(1_000_000, 900_000_000)),
    user: '5001',
    website: String(randomInt(1_000_000, 900_000_000)),
  };
}

export function api(app: Parameters<typeof request>[0], scope: ReturnType<typeof newScope>, perms = ALL_PERMS) {
  const h = (r: request.Test) =>
    r
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('X-Tenant-Id', scope.tenant)
      .set('X-Organization-Id', scope.org)
      .set('X-Software-Id', '10')
      .set('X-User-Id', scope.user)
      .set('X-Permissions', perms);
  return {
    get: (p: string) => h(request(app).get(p)),
    post: (p: string) => h(request(app).post(p)),
    patch: (p: string) => h(request(app).patch(p)),
    put: (p: string) => h(request(app).put(p)),
    delete: (p: string) => h(request(app).delete(p)),
  };
}
