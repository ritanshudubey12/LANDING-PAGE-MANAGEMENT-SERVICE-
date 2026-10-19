import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../config/env';

const DIR = path.join(__dirname, '..', '..', 'migrations');

async function runInTx(pool: Pool, sql: string, bookkeeping: string, name: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(bookkeeping, [name]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const MIGRATION_LOCK_ID = 727_001;

/** Serialise concurrent runners (e.g. several replicas starting at once) with a session advisory lock. */
export async function migrate(pool: Pool, direction: 'up' | 'down'): Promise<string[]> {
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    return await migrateLocked(pool, direction);
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    lock.release();
  }
}

async function migrateLocked(pool: Pool, direction: 'up' | 'down'): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
  );
  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const names = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.up.sql'))
    .map((f) => f.replace('.up.sql', ''))
    .sort();
  const done: string[] = [];

  if (direction === 'up') {
    for (const name of names.filter((n) => !applied.has(n))) {
      await runInTx(pool, fs.readFileSync(path.join(DIR, `${name}.up.sql`), 'utf8'), 'INSERT INTO schema_migrations(name) VALUES ($1)', name);
      done.push(name);
    }
  } else {
    const last = names.filter((n) => applied.has(n)).pop();
    if (last) {
      await runInTx(pool, fs.readFileSync(path.join(DIR, `${last}.down.sql`), 'utf8'), 'DELETE FROM schema_migrations WHERE name = $1', last);
      done.push(last);
    }
  }
  return done;
}

if (require.main === module) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL });
  migrate(pool, direction)
    .then((done) => console.log(`migrate ${direction}: ${done.length ? done.join(', ') : 'nothing to do'}`))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
