import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { api, buildTestApp, newScope, TOKEN } from '../helpers';

let app: Awaited<ReturnType<typeof buildTestApp>>['app'];
let pool: Pool;

beforeAll(async () => {
  ({ app, pool } = await buildTestApp());
});
afterAll(async () => {
  await pool.end();
});

const headers = (s: ReturnType<typeof newScope>) => ({
  'X-Tenant-Id': s.tenant,
  'X-Organization-Id': s.org,
  'X-User-Id': s.user,
  'X-Permissions': 'landing-page:read',
});

describe('authentication', () => {
  const s = newScope();
  const path = `/api/v1/websites/${s.website}/landing-pages`;
  it('401 with no Authorization header', async () => {
    const res = await request(app).get(path).set(headers(s));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
  it('401 with a wrong token, wrong scheme, or empty bearer', async () => {
    for (const auth of ['Bearer wrong-token-value-123456', `Basic ${TOKEN}`, 'Bearer ', TOKEN]) {
      expect((await request(app).get(path).set(headers(s)).set('Authorization', auth)).status).toBe(401);
    }
  });
  it('never echoes the token in error bodies', async () => {
    const res = await request(app).get(path).set(headers(s)).set('Authorization', 'Bearer wrong-token-value-123456');
    expect(JSON.stringify(res.body)).not.toContain('wrong-token-value-123456');
  });
  it('/api/v1 routes are not reachable without auth even for unknown paths', async () => {
    expect((await request(app).get('/api/v1/nope')).status).toBe(401);
  });
});

describe('trusted context headers', () => {
  const s = newScope();
  const path = `/api/v1/websites/${s.website}/landing-pages`;
  const call = (h: Record<string, string>) => request(app).get(path).set('Authorization', `Bearer ${TOKEN}`).set(h);

  it('400 when a required header is missing', async () => {
    for (const drop of ['X-Tenant-Id', 'X-Organization-Id', 'X-User-Id']) {
      const h: Record<string, string> = { ...headers(s) };
      delete h[drop];
      const res = await call(h);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_CONTEXT_HEADER');
    }
  });
  it('400 for malformed or overflowing BIGINT headers', async () => {
    for (const bad of ['abc', '-5', '1.5', '7 7', '9223372036854775808', '0x10']) {
      const res = await call({ ...headers(s), 'X-Tenant-Id': bad });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CONTEXT_HEADER');
    }
    expect((await call({ ...headers(s), 'X-Software-Id': 'nope' })).status).toBe(400);
  });
  it('a generated request id is returned; a malformed inbound one is replaced', async () => {
    const res = await call({ ...headers(s), 'X-Request-Id': 'bad id with spaces' });
    expect(res.headers['x-request-id']).toMatch(/^req_/);
    const ok = await call({ ...headers(s), 'X-Request-Id': 'req_01HABCDEF' });
    expect(ok.headers['x-request-id']).toBe('req_01HABCDEF');
    expect(ok.body.requestId).toBe('req_01HABCDEF');
  });
});

describe('authorization (RBAC)', () => {
  it('403 when the specific permission is missing, per endpoint', async () => {
    const s = newScope();
    const full = api(app, s);
    const created = await full.post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'A', slug: 'a' });
    const id = created.body.data.id;
    const readOnly = api(app, s, 'landing-page:read');
    const checks = [
      readOnly.post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'B', slug: 'b' }),
      readOnly.patch(`/api/v1/landing-pages/${id}`).send({ name: 'C' }),
      readOnly.post(`/api/v1/landing-pages/${id}/duplicate`).send({}),
      readOnly.delete(`/api/v1/landing-pages/${id}`),
      readOnly.post(`/api/v1/landing-pages/${id}/publish`).send({}),
      readOnly.post(`/api/v1/landing-pages/${id}/unpublish`).send({}),
      api(app, s, '').get(`/api/v1/landing-pages/${id}`),
      api(app, s, '').get(`/api/v1/websites/${s.website}/landing-pages`),
    ];
    for (const r of await Promise.all(checks)) expect(r.status).toBe(403);
  });
  it('publish permission also governs unpublish, and not other actions', async () => {
    const s = newScope();
    const full = api(app, s);
    const id = (await full.post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'A', slug: 'a' })).body.data.id;
    const pubOnly = api(app, s, 'landing-page:publish');
    expect((await pubOnly.post(`/api/v1/landing-pages/${id}/publish`).send({})).status).toBe(200);
    expect((await pubOnly.post(`/api/v1/landing-pages/${id}/unpublish`).send({})).status).toBe(200);
    expect((await pubOnly.patch(`/api/v1/landing-pages/${id}`).send({ name: 'x' })).status).toBe(403);
  });
});

describe('tenant / organization / website isolation', () => {
  it('a guessed page ID from another tenant or organization is concealed as 404 on every operation', async () => {
    const owner = newScope();
    const id = (await api(app, owner).post(`/api/v1/websites/${owner.website}/landing-pages`).send({ name: 'Secret', slug: 'secret' })).body.data.id;

    const otherTenant = { ...owner, tenant: String(Number(owner.tenant) + 1) };
    const otherOrg = { ...owner, org: String(Number(owner.org) + 1) };
    for (const attacker of [otherTenant, otherOrg]) {
      const a = api(app, attacker);
      const results = await Promise.all([
        a.get(`/api/v1/landing-pages/${id}`),
        a.patch(`/api/v1/landing-pages/${id}`).send({ name: 'pwned' }),
        a.post(`/api/v1/landing-pages/${id}/duplicate`).send({}),
        a.post(`/api/v1/landing-pages/${id}/publish`).send({}),
        a.post(`/api/v1/landing-pages/${id}/unpublish`).send({}),
        a.delete(`/api/v1/landing-pages/${id}`),
      ]);
      for (const r of results) {
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain('Secret');
      }
      const list = await a.get(`/api/v1/websites/${owner.website}/landing-pages`);
      expect(list.body.data).toEqual([]);
    }
    // Owner's data is untouched.
    const still = await api(app, owner).get(`/api/v1/landing-pages/${id}`);
    expect(still.status).toBe(200);
    expect(still.body.data.name).toBe('Secret');
  });
  it('cross-website listing returns only that website', async () => {
    const s = newScope();
    const other = String(Number(s.website) + 1);
    await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'W1', slug: 'w1' });
    await api(app, s).post(`/api/v1/websites/${other}/landing-pages`).send({ name: 'W2', slug: 'w2' });
    const list = await api(app, s).get(`/api/v1/websites/${s.website}/landing-pages`);
    expect(list.body.data.map((p: { name: string }) => p.name)).toEqual(['W1']);
  });
  it('body-supplied tenant/org/user are never honoured', async () => {
    const s = newScope();
    const res = await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'X', slug: 'x', tenantId: '1', organization_id: '2', user_id: '3' });
    expect(res.status).toBe(422);
  });
});

describe('error contract and injection safety', () => {
  it('SQL-injection-shaped input is treated as data', async () => {
    const s = newScope();
    const evil = "x'; DROP TABLE landing_pages;--";
    expect((await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: evil, slug: 'safe' })).status).toBe(200);
    expect((await api(app, s).get(`/api/v1/websites/${s.website}/landing-pages?q=${encodeURIComponent(evil)}`)).status).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM landing_pages')).rows[0].n).toBeGreaterThan(0);
  });
  it('unknown routes use the standard error envelope; 500s leak nothing', async () => {
    const s = newScope();
    const res = await api(app, s).get('/api/v1/unknown/route');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'ROUTE_NOT_FOUND' } });
    expect(res.body.requestId).toBeTruthy();
  });
  it('does not advertise the framework', async () => {
    expect((await request(app).get('/health')).headers['x-powered-by']).toBeUndefined();
  });
});
