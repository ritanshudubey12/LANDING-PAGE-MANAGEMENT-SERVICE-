import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { api, buildTestApp, newScope } from '../helpers';
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

async function createPage(scope = newScope(), body: Record<string, unknown> = { name: 'Spring Campaign', slug: 'spring-campaign' }) {
  const res = await api(app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send(body);
  return { scope, res };
}

describe('health and readiness', () => {
  it('GET /health -> 200 without credentials', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });
  it('GET /ready -> 200 when dependencies are usable', async () => {
    const { default: request } = await import('supertest');
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.checks).toEqual({ database: true, integrations: true });
  });
});

describe('create', () => {
  it('creates an unpublished page with string IDs and an ETag', async () => {
    const { scope, res } = await createPage();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const d = res.body.data;
    expect(typeof d.id).toBe('string');
    expect(d.websiteId).toBe(scope.website);
    expect(d.slug).toBe('spring-campaign');
    expect(d.lifecycleStatus).toBe('ACTIVE');
    expect(d.publicationStatus).toBe('UNPUBLISHED');
    expect(d.publishedRevisionId).toBeNull();
    expect(d.hasUnpublishedChanges).toBe(true);
    expect(typeof d.documentId).toBe('string');
    expect(res.headers.etag).toBe('"page-v1"');
    expect(res.body.requestId).toBeTruthy();
  });
  it('derives a slug from the name when omitted', async () => {
    const { res } = await createPage(newScope(), { name: 'Black Friday Deals' });
    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe('black-friday-deals');
  });
  it('normalizes slug case', async () => {
    const { res } = await createPage(newScope(), { name: 'X', slug: 'Mixed-Case' });
    expect(res.body.data.slug).toBe('mixed-case');
  });
  it('rejects tenant/user/publication fields in the body (422)', async () => {
    const { res } = await createPage(newScope(), { name: 'X', slug: 'x', tenant_id: '9', publicationStatus: 'PUBLISHED' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
  it('rejects an invalid slug (422) and empty name (422)', async () => {
    expect((await createPage(newScope(), { name: 'X', slug: 'Bad Slug!' })).res.status).toBe(422);
    expect((await createPage(newScope(), { name: '  ', slug: 'ok' })).res.status).toBe(422);
  });
  it('returns 409 for a duplicate slug (case-insensitive) in the same website', async () => {
    const { scope } = await createPage();
    const again = await api(app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: 'Other', slug: 'SPRING-campaign' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('LANDING_PAGE_SLUG_CONFLICT');
  });
  it('allows the same slug on a different website', async () => {
    const { scope } = await createPage();
    const other = await api(app, scope).post(`/api/v1/websites/${Number(scope.website) + 1}/landing-pages`).send({ name: 'A', slug: 'spring-campaign' });
    expect(other.status).toBe(200);
  });
  it('concurrent creates with the same slug: exactly one wins (DB constraint)', async () => {
    const scope = newScope();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        api(app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: `Race ${i}`, slug: 'race-slug' }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(5);
  });
  it('is idempotent with Idempotency-Key and detects key reuse with a different body', async () => {
    const scope = newScope();
    const send = (body: object) =>
      api(app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).set('Idempotency-Key', 'create-key-1').send(body);
    const first = await send({ name: 'Idem', slug: 'idem' });
    const retry = await send({ name: 'Idem', slug: 'idem' });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    const reuse = await send({ name: 'Different', slug: 'different' });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('round-trips BIGINT scope IDs above 2^53-1 exactly', async () => {
    const scope = { ...newScope(), tenant: '9007199254740993', org: '9007199254740995', website: '9007199254740999' };
    const { res } = await createPage(scope, { name: 'Big', slug: `big-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(res.body.data.websiteId).toBe('9007199254740999');
    const got = await api(app, scope).get(`/api/v1/landing-pages/${res.body.data.id}`);
    expect(got.body.data.websiteId).toBe('9007199254740999');
  });
  it('rejects malformed / overflowing website IDs (400)', async () => {
    const scope = newScope();
    for (const bad of ['abc', '0', '9223372036854775808', '1e3']) {
      const res = await api(app, scope).post(`/api/v1/websites/${bad}/landing-pages`).send({ name: 'X', slug: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ID');
    }
  });
  it('returns 400 for malformed JSON', async () => {
    const scope = newScope();
    const res = await api(app, scope)
      .post(`/api/v1/websites/${scope.website}/landing-pages`)
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
  it('discards the draft and enqueues cleanup when persistence fails after document creation', async () => {
    const discarded: string[] = [];
    const t = await buildTestApp((base) => ({
      ...base,
      documents: {
        ...base.documents,
        discardDraft: async (_c, id) => {
          discarded.push(id);
          throw new Error('document service down');
        },
      },
    }));
    const scope = newScope();
    const a = api(t.app, scope);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => a.post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: `R${i}`, slug: 'dup' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    // Every draft that was created but not persisted was attempted for discard, and each failed discard is queued for retry.
    const queued = await t.pool.query(`SELECT count(*)::int AS n FROM workflow_operations WHERE tenant_id = $1`, [scope.tenant]);
    expect(queued.rows[0].n).toBe(discarded.length);
    // Exactly one page row exists for the slug.
    const rows = await t.pool.query(`SELECT count(*)::int AS n FROM landing_pages WHERE tenant_id = $1`, [scope.tenant]);
    expect(rows.rows[0].n).toBe(1);
    await t.pool.end();
  });
});

describe('list', () => {
  it('lists with cursor pagination, stable order, and no duplicates across pages', async () => {
    const scope = newScope();
    for (let i = 0; i < 5; i++) await createPage(scope, { name: `Page ${i}`, slug: `page-${i}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: any = await api(app, scope).get(`/api/v1/websites/${scope.website}/landing-pages?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.data.map((p: { id: string }) => p.id));
      cursor = res.body.meta.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(pages).toBe(3);
  });
  it('supports sort by name asc, filtering and search', async () => {
    const scope = newScope();
    await createPage(scope, { name: 'Zebra', slug: 'zebra' });
    await createPage(scope, { name: 'Apple', slug: 'apple' });
    const sorted = await api(app, scope).get(`/api/v1/websites/${scope.website}/landing-pages?sortBy=name&order=asc`);
    expect(sorted.body.data.map((p: { name: string }) => p.name)).toEqual(['Apple', 'Zebra']);
    const found = await api(app, scope).get(`/api/v1/websites/${scope.website}/landing-pages?q=zeb`);
    expect(found.body.data).toHaveLength(1);
    const pub = await api(app, scope).get(`/api/v1/websites/${scope.website}/landing-pages?publicationStatus=PUBLISHED`);
    expect(pub.body.data).toHaveLength(0);
  });
  it('treats LIKE wildcards in q literally', async () => {
    const scope = newScope();
    await createPage(scope, { name: 'Plain', slug: 'plain' });
    const res = await api(app, scope).get(`/api/v1/websites/${scope.website}/landing-pages?q=%25`);
    expect(res.body.data).toHaveLength(0);
  });
  it('rejects out-of-range limit, unknown sort key, and tampered cursor', async () => {
    const scope = newScope();
    const base = `/api/v1/websites/${scope.website}/landing-pages`;
    expect((await api(app, scope).get(`${base}?limit=1000`)).status).toBe(422);
    expect((await api(app, scope).get(`${base}?sortBy=tenant_id;drop`)).status).toBe(422);
    expect((await api(app, scope).get(`${base}?cursor=garbage`)).status).toBe(400);
  });
});

describe('get / update', () => {
  it('gets a page and 404s for unknown IDs', async () => {
    const { scope, res } = await createPage();
    expect((await api(app, scope).get(`/api/v1/landing-pages/${res.body.data.id}`)).status).toBe(200);
    const missing = await api(app, scope).get('/api/v1/landing-pages/999999999999');
    expect(missing.status).toBe(404);
  });
  it('renames and changes slug, bumping the ETag version', async () => {
    const { scope, res } = await createPage();
    const patch = await api(app, scope)
      .patch(`/api/v1/landing-pages/${res.body.data.id}`)
      .set('If-Match', '"page-v1"')
      .send({ name: 'Spring Sale', slug: 'spring-sale' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.name).toBe('Spring Sale');
    expect(patch.body.data.slug).toBe('spring-sale');
    expect(patch.headers.etag).toBe('"page-v2"');
    expect(patch.body.data.publicationStatus).toBe('UNPUBLISHED'); // metadata edits never publish
  });
  it('returns 412 for a stale If-Match and 400 for a malformed one', async () => {
    const { scope, res } = await createPage();
    const id = res.body.data.id;
    await api(app, scope).patch(`/api/v1/landing-pages/${id}`).send({ name: 'v2' });
    const stale = await api(app, scope).patch(`/api/v1/landing-pages/${id}`).set('If-Match', '"page-v1"').send({ name: 'late' });
    expect(stale.status).toBe(412);
    const bad = await api(app, scope).patch(`/api/v1/landing-pages/${id}`).set('If-Match', 'junk').send({ name: 'x' });
    expect(bad.status).toBe(400);
  });
  it('returns 409 when the new slug collides, and 422 for an empty patch', async () => {
    const scope = newScope();
    await createPage(scope, { name: 'One', slug: 'one' });
    const two = await createPage(scope, { name: 'Two', slug: 'two' });
    const clash = await api(app, scope).patch(`/api/v1/landing-pages/${two.res.body.data.id}`).send({ slug: 'one' });
    expect(clash.status).toBe(409);
    const empty = await api(app, scope).patch(`/api/v1/landing-pages/${two.res.body.data.id}`).send({});
    expect(empty.status).toBe(422);
  });
  it('exactly one of N concurrent PATCHes with the same If-Match succeeds', async () => {
    const { scope, res } = await createPage();
    const id = res.body.data.id;
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => api(app, scope).patch(`/api/v1/landing-pages/${id}`).set('If-Match', '"page-v1"').send({ name: `N${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 412)).toHaveLength(3);
  });
});

describe('duplicate', () => {
  it('creates an independent, unpublished copy with a new ID and document', async () => {
    const { scope, res } = await createPage();
    const src = res.body.data;
    await api(app, scope).post(`/api/v1/landing-pages/${src.id}/publish`).send({});
    const dup = await api(app, scope)
      .post(`/api/v1/landing-pages/${src.id}/duplicate`)
      .set('Idempotency-Key', 'dup-key-1')
      .send({ name: 'Spring Campaign - Copy', slug: 'spring-campaign-copy' });
    expect(dup.status).toBe(200);
    expect(dup.body.data.id).not.toBe(src.id);
    expect(dup.body.data.documentId).not.toBe(src.documentId);
    expect(dup.body.data.publicationStatus).toBe('UNPUBLISHED');
    expect(dup.body.data.publishedRevisionId).toBeNull();
    expect(dup.body.data.websiteId).toBe(src.websiteId);
    const retry = await api(app, scope)
      .post(`/api/v1/landing-pages/${src.id}/duplicate`)
      .set('Idempotency-Key', 'dup-key-1')
      .send({ name: 'Spring Campaign - Copy', slug: 'spring-campaign-copy' });
    expect(retry.body.data.id).toBe(dup.body.data.id);
  });
  it('defaults name/slug and 409s on a taken slug', async () => {
    const { scope, res } = await createPage();
    const first = await api(app, scope).post(`/api/v1/landing-pages/${res.body.data.id}/duplicate`).send({});
    expect(first.status).toBe(200);
    expect(first.body.data.slug).toBe('spring-campaign-copy');
    const second = await api(app, scope).post(`/api/v1/landing-pages/${res.body.data.id}/duplicate`).send({});
    expect(second.status).toBe(409);
  });
});

describe('publish / unpublish', () => {
  it('requires explicit action; publish then unpublish', async () => {
    const { scope, res } = await createPage();
    const id = res.body.data.id;
    expect(res.body.data.publicationStatus).toBe('UNPUBLISHED');
    const pub = await api(app, scope).post(`/api/v1/landing-pages/${id}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.publicationStatus).toBe('PUBLISHED');
    expect(typeof pub.body.data.publishedRevisionId).toBe('string');
    expect(pub.body.data.hasUnpublishedChanges).toBe(false);
    const unpub = await api(app, scope).post(`/api/v1/landing-pages/${id}/unpublish`).send({});
    expect(unpub.status).toBe(200);
    expect(unpub.body.data.publicationStatus).toBe('UNPUBLISHED');
    expect(unpub.body.data.publishedRevisionId).toBeNull();
  });
  it('409s when unpublishing a page that is not published', async () => {
    const { scope, res } = await createPage();
    const r = await api(app, scope).post(`/api/v1/landing-pages/${res.body.data.id}/unpublish`).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_LIFECYCLE_TRANSITION');
  });
  it('never reports PUBLISHED when Publishing is unavailable (503, state unchanged)', async () => {
    const t = await buildTestApp((base) => ({
      ...base,
      publishing: {
        ...base.publishing,
        publish: async () => {
          const { unavailable } = await import('../../src/lib/errors');
          throw unavailable('PUBLISHING_UNAVAILABLE', 'Publishing is down');
        },
      },
    }));
    const scope = newScope();
    const created = await api(t.app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: 'P', slug: 'p' });
    const pub = await api(t.app, scope).post(`/api/v1/landing-pages/${created.body.data.id}/publish`).send({});
    expect(pub.status).toBe(503);
    const after = await api(t.app, scope).get(`/api/v1/landing-pages/${created.body.data.id}`);
    expect(after.body.data.publicationStatus).toBe('UNPUBLISHED');
    await t.pool.end();
  });
  it('records PUBLISH_PENDING exactly as reported by Publishing', async () => {
    const t = await buildTestApp((base) => ({
      ...base,
      publishing: { ...base.publishing, publish: async () => ({ publicationStatus: 'PUBLISH_PENDING', publishedRevisionId: null }) },
    }));
    const scope = newScope();
    const created = await api(t.app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: 'P', slug: 'p' });
    const pub = await api(t.app, scope).post(`/api/v1/landing-pages/${created.body.data.id}/publish`).send({});
    expect(pub.status).toBe(200);
    expect(pub.body.data.publicationStatus).toBe('PUBLISH_PENDING');
    expect(pub.body.data.hasUnpublishedChanges).toBe(true);
    await t.pool.end();
  });
  it('notifies Publishing when a published page changes slug', async () => {
    const calls: Array<{ oldSlug: string; newSlug: string }> = [];
    const t = await buildTestApp((base) => ({
      ...base,
      publishing: { ...base.publishing, notifySlugChange: async (_c, i) => void calls.push(i) },
    }));
    const scope = newScope();
    const created = await api(t.app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: 'P', slug: 'old' });
    const id = created.body.data.id;
    await api(t.app, scope).post(`/api/v1/landing-pages/${id}/publish`).send({});
    await api(t.app, scope).patch(`/api/v1/landing-pages/${id}`).send({ slug: 'new' });
    expect(calls).toEqual([expect.objectContaining({ oldSlug: 'old', newSlug: 'new' })]);
    await t.pool.end();
  });
});

describe('delete', () => {
  it('soft-deletes, excludes from list/get, and releases the slug', async () => {
    const { scope, res } = await createPage();
    const id = res.body.data.id;
    const del = await api(app, scope).delete(`/api/v1/landing-pages/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ id, deleted: true });
    expect((await api(app, scope).get(`/api/v1/landing-pages/${id}`)).status).toBe(404);
    const list = await api(app, scope).get(`/api/v1/websites/${scope.website}/landing-pages`);
    expect(list.body.data).toHaveLength(0);
    const reuse = await api(app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: 'Again', slug: 'spring-campaign' });
    expect(reuse.status).toBe(200);
    const row = await pool.query('SELECT deleted_at FROM landing_pages WHERE id = $1', [id]);
    expect(row.rows[0].deleted_at).not.toBeNull(); // tombstone retained
  });
  it('unpublishes a live page first; refuses to delete if unpublish is not confirmed', async () => {
    const t = await buildTestApp((base) => ({
      ...base,
      publishing: { ...base.publishing, unpublish: async () => ({ publicationStatus: 'UNPUBLISH_PENDING', publishedRevisionId: 'x' }) },
    }));
    const scope = newScope();
    const created = await api(t.app, scope).post(`/api/v1/websites/${scope.website}/landing-pages`).send({ name: 'P', slug: 'p' });
    const id = created.body.data.id;
    await api(t.app, scope).post(`/api/v1/landing-pages/${id}/publish`).send({});
    const del = await api(t.app, scope).delete(`/api/v1/landing-pages/${id}`);
    expect(del.status).toBe(503);
    expect((await api(t.app, scope).get(`/api/v1/landing-pages/${id}`)).status).toBe(200);
    await t.pool.end();
  });
});

describe('audit and reconciliation', () => {
  it('writes audit rows for lifecycle actions', async () => {
    const { scope, res } = await createPage();
    const id = res.body.data.id;
    await api(app, scope).patch(`/api/v1/landing-pages/${id}`).send({ name: 'Renamed' });
    await api(app, scope).delete(`/api/v1/landing-pages/${id}`);
    const rows = await pool.query('SELECT action FROM audit_log WHERE tenant_id = $1 AND resource_id = $2 ORDER BY id', [scope.tenant, id]);
    expect(rows.rows.map((r) => r.action)).toEqual(['LANDING_PAGE_CREATED', 'LANDING_PAGE_RENAMED', 'LANDING_PAGE_DELETED']);
  });
  it('reconciler retries queued orphan-draft cleanup', async () => {
    const scope = newScope();
    await pool.query(
      `INSERT INTO workflow_operations (kind, tenant_id, organization_id, user_id, document_id) VALUES ('DISCARD_DRAFT', $1, $2, $3, 42)`,
      [scope.tenant, scope.org, scope.user],
    );
    const done = await reconcileOnce(pool, integrations, createLogger('error', () => undefined));
    expect(done).toBeGreaterThanOrEqual(1);
    const left = await pool.query(`SELECT 1 FROM workflow_operations WHERE tenant_id = $1 AND status = 'PENDING'`, [scope.tenant]);
    expect(left.rowCount).toBe(0);
  });
});
