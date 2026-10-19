import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { api, buildTestApp, newScope } from '../helpers';
import { migrate } from '../../src/database/migrate';
import { reconcileOnce } from '../../src/jobs/reconciliation.worker';
import { createLogger } from '../../src/lib/logger';

let app: Awaited<ReturnType<typeof buildTestApp>>['app'];
let pool: Pool;
let integrations: Awaited<ReturnType<typeof buildTestApp>>['integrations'];

beforeAll(async () => {
  ({ app, pool, integrations } = await buildTestApp());
});
afterAll(async () => {
  await pool.end();
});

const NUL = String.fromCharCode(0);
const cursorOf = (v: string, sortBy = 'createdAt') =>
  Buffer.from(JSON.stringify({ s: sortBy, o: 'desc', v, id: '5' })).toString('base64url');

describe('regression: NUL characters were causing HTTP 500', () => {
  it('rejects NUL in name on create, patch and duplicate (422)', async () => {
    const s = newScope();
    const bad = `a${NUL}b`;
    expect((await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: bad, slug: 'nul' })).status).toBe(422);
    const id = (await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'ok', slug: 'ok' })).body.data.id;
    expect((await api(app, s).patch(`/api/v1/landing-pages/${id}`).send({ name: bad })).status).toBe(422);
    expect((await api(app, s).post(`/api/v1/landing-pages/${id}/duplicate`).send({ name: bad })).status).toBe(422);
  });
  it('rejects NUL in q (422) and in a cursor (400/422), never 500', async () => {
    const s = newScope();
    const base = `/api/v1/websites/${s.website}/landing-pages`;
    expect((await api(app, s).get(`${base}?q=a%00b`)).status).toBe(422);
    const nulCursor = await api(app, s).get(`${base}?sortBy=name&cursor=${cursorOf(`a${NUL}b`, 'name')}`);
    expect(nulCursor.status).toBe(400);
    expect(nulCursor.body.error.code).toBe('INVALID_CURSOR');
  });
  it('maps an impossible date inside a well-formed cursor to 400, not 500', async () => {
    const s = newScope();
    const res = await api(app, s).get(`/api/v1/websites/${s.website}/landing-pages?cursor=${cursorOf('2026-13-45 99:00:00+00')}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
  it('maps a date that passes the format check but fails in PostgreSQL to 400', async () => {
    const s = newScope();
    const res = await api(app, s).get(`/api/v1/websites/${s.website}/landing-pages?cursor=${cursorOf('2026-02-31 10:00:00+00')}`);
    expect(res.status).toBe(400);
  });
});

describe('regression: duplicate of a maximum-length slug', () => {
  it('keeps a clean "-copy" suffix and a valid slug within 180 chars', async () => {
    const s = newScope();
    const slug = 'a'.repeat(180);
    const created = await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'Long', slug });
    expect(created.status).toBe(200);
    const dup = await api(app, s).post(`/api/v1/landing-pages/${created.body.data.id}/duplicate`).send({});
    expect(dup.status).toBe(200);
    expect(dup.body.data.slug.endsWith('-copy')).toBe(true);
    expect(dup.body.data.slug.length).toBeLessThanOrEqual(180);
  });
  it('does not leave a dangling hyphen when truncation lands on one', async () => {
    const s = newScope();
    const slug = `${'a'.repeat(174)}-bcd`; // truncating to 175 would end in "-"
    const created = await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'Edge', slug });
    const dup = await api(app, s).post(`/api/v1/landing-pages/${created.body.data.id}/duplicate`).send({});
    expect(dup.status).toBe(200);
    expect(dup.body.data.slug).not.toMatch(/--/);
    expect(dup.body.data.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

describe('regression: concurrent migrations', () => {
  it('parallel runners are serialised and idempotent (no error, nothing re-applied)', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => migrate(pool, 'up')));
    expect(results.every((r) => r.length === 0)).toBe(true);
  });
});

describe('regression: idempotency key housekeeping', () => {
  it('purges completed keys older than 24h and abandoned claims older than 5 minutes, keeps fresh ones', async () => {
    const s = newScope();
    const insert = (key: string, body: string | null, age: string) =>
      pool.query(
        `INSERT INTO idempotency_keys (tenant_id, organization_id, user_id, operation, idempotency_key, request_hash, response_body, created_at)
         VALUES ($1, $2, $3, 'create:1', $4, repeat('a', 64), $5::jsonb, NOW() - $6::interval)`,
        [s.tenant, s.org, s.user, key, body, age],
      );
    await insert('old-done', '{"x":1}', '25 hours');
    await insert('stuck', null, '10 minutes');
    await insert('fresh-done', '{"x":1}', '1 hour');
    await insert('fresh-inflight', null, '1 minute');
    await reconcileOnce(pool, integrations, createLogger('error', () => undefined));
    const left = await pool.query('SELECT idempotency_key FROM idempotency_keys WHERE tenant_id = $1 ORDER BY 1', [s.tenant]);
    expect(left.rows.map((r) => r.idempotency_key)).toEqual(['fresh-done', 'fresh-inflight']);
  });
});
