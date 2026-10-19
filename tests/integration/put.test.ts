import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { api, buildTestApp, newScope } from '../helpers';

let app: Awaited<ReturnType<typeof buildTestApp>>['app'];
let pool: Pool;

beforeAll(async () => {
  ({ app, pool } = await buildTestApp());
});
afterAll(async () => {
  await pool.end();
});

async function seed() {
  const s = newScope();
  const res = await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'Original', slug: 'original' });
  return { s, id: res.body.data.id as string };
}

describe('PUT /api/v1/landing-pages/{id}', () => {
  it('replaces name and slug, bumps the ETag, and never publishes', async () => {
    const { s, id } = await seed();
    const res = await api(app, s).put(`/api/v1/landing-pages/${id}`).set('If-Match', '"page-v1"').send({ name: 'Replaced', slug: 'replaced' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id, name: 'Replaced', slug: 'replaced', publicationStatus: 'UNPUBLISHED' });
    expect(res.headers.etag).toBe('"page-v2"');
  });
  it('requires BOTH name and slug (422 otherwise; PATCH stays partial)', async () => {
    const { s, id } = await seed();
    expect((await api(app, s).put(`/api/v1/landing-pages/${id}`).send({ name: 'Only name' })).status).toBe(422);
    expect((await api(app, s).put(`/api/v1/landing-pages/${id}`).send({ slug: 'only-slug' })).status).toBe(422);
    expect((await api(app, s).put(`/api/v1/landing-pages/${id}`).send({})).status).toBe(422);
    expect((await api(app, s).patch(`/api/v1/landing-pages/${id}`).send({ name: 'Partial ok' })).status).toBe(200);
  });
  it('rejects tenant/user fields in the body (422)', async () => {
    const { s, id } = await seed();
    const res = await api(app, s).put(`/api/v1/landing-pages/${id}`).send({ name: 'N', slug: 'n', tenant_id: '9' });
    expect(res.status).toBe(422);
  });
  it('412 on a stale If-Match, 409 on a slug collision, 404 out of scope, 403 without permission', async () => {
    const { s, id } = await seed();
    await api(app, s).post(`/api/v1/websites/${s.website}/landing-pages`).send({ name: 'Other', slug: 'taken' });
    await api(app, s).patch(`/api/v1/landing-pages/${id}`).send({ name: 'bump' });
    expect((await api(app, s).put(`/api/v1/landing-pages/${id}`).set('If-Match', '"page-v1"').send({ name: 'x', slug: 'x' })).status).toBe(412);
    expect((await api(app, s).put(`/api/v1/landing-pages/${id}`).send({ name: 'x', slug: 'taken' })).status).toBe(409);
    const stranger = { ...s, tenant: String(Number(s.tenant) + 1) };
    expect((await api(app, stranger).put(`/api/v1/landing-pages/${id}`).send({ name: 'x', slug: 'x' })).status).toBe(404);
    expect((await api(app, s, 'landing-page:read').put(`/api/v1/landing-pages/${id}`).send({ name: 'x', slug: 'x' })).status).toBe(403);
  });
});
