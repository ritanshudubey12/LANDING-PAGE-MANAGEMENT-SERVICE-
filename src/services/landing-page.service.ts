import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Integrations } from '../integrations/clients';
import { badRequest, conflict, notFound, preconditionFailed, unavailable } from '../lib/errors';
import { isBigIntId } from '../lib/bigint';
import { normalizeSlug, slugify } from '../lib/slug';
import type { Logger } from '../lib/logger';
import { LandingPageRepository, type ListFilters, type SortBy } from '../repositories/landing-page.repository';
import { AuditRepository, IdempotencyRepository, WorkflowOperationRepository } from '../repositories/support.repository';
import type { CreateBody, DuplicateBody, ListQuery, UpdateBody } from '../schemas/landing-page.schema';
import type { LandingPageRow, RequestContext } from '../types';

export type LandingPageDto = ReturnType<typeof toDto>;

export function toDto(r: LandingPageRow) {
  return {
    id: r.id,
    websiteId: r.website_id,
    name: r.name,
    slug: r.slug,
    lifecycleStatus: r.lifecycle_status,
    publicationStatus: r.publication_status,
    documentId: r.document_id,
    publishedRevisionId: r.published_revision_id,
    hasUnpublishedChanges: r.has_unpublished_changes,
    version: r.version,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
  };
}

export const etagFor = (version: number) => `"page-v${version}"`;

/** Parse If-Match: absent or `*` => no precondition; `"page-vN"` => N. */
export function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined || header.trim() === '*') return null;
  const m = /^(?:W\/)?"page-v(\d{1,9})"$/.exec(header.trim());
  if (!m) throw badRequest('INVALID_IF_MATCH', 'If-Match must be an ETag returned by this API, e.g. "page-v3"');
  return Number(m[1]);
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505';
const slugConflict = () => conflict('LANDING_PAGE_SLUG_CONFLICT', 'This slug is already in use.');

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

type Cursor = { s: SortBy; o: 'asc' | 'desc'; v: string; id: string };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string, sortBy: SortBy, order: 'asc' | 'desc'): { v: string; id: string } {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (c.s !== sortBy || c.o !== order || typeof c.v !== 'string' || !isBigIntId(c.id)) throw new Error('mismatch');
    if (c.v.includes('\u0000') || c.v.length > 200) throw new Error('bad value');
    if (sortBy !== 'name' && !TIMESTAMP.test(c.v)) throw new Error('bad timestamp');
    return { v: c.v, id: c.id };
  } catch {
    throw badRequest('INVALID_CURSOR', 'cursor is invalid or does not match the requested sort');
  }
}

export class LandingPageService {
  private readonly pages: LandingPageRepository;
  private readonly idem: IdempotencyRepository;
  private readonly audit: AuditRepository;
  private readonly ops: WorkflowOperationRepository;

  constructor(
    pool: Pool,
    private readonly integrations: Integrations,
    private readonly logger: Logger,
  ) {
    this.pages = new LandingPageRepository(pool);
    this.idem = new IdempotencyRepository(pool);
    this.audit = new AuditRepository(pool);
    this.ops = new WorkflowOperationRepository(pool);
  }

  // ---------- helpers ----------

  private async recordAudit(ctx: RequestContext, action: string, resourceId: string | null, details: Record<string, unknown> = {}) {
    try {
      await this.audit.record(ctx, action, resourceId, details);
    } catch (e) {
      this.logger.error('audit_write_failed', { requestId: ctx.requestId, action, error: String(e) });
    }
  }

  /** Scoped load; a page outside the caller's scope is indistinguishable from a missing one (404). */
  private async load(ctx: RequestContext, id: string): Promise<LandingPageRow> {
    const row = await this.pages.findById(ctx, id);
    if (!row) throw notFound();
    await this.integrations.website.assertWebsiteInScope(ctx, row.website_id);
    return row;
  }

  /** Best-effort cleanup of a draft created for a page that was never persisted; retried by the reconciler. */
  private async discardOrphanDraft(ctx: RequestContext, documentId: string) {
    try {
      await this.integrations.documents.discardDraft(ctx, documentId);
    } catch (e) {
      await this.ops.enqueueDiscardDraft(ctx, documentId, String(e));
      this.logger.warn('orphan_draft_enqueued', { requestId: ctx.requestId, documentId });
    }
  }

  private async withIdempotency<T>(
    ctx: RequestContext,
    operation: string,
    key: string | undefined,
    requestFingerprint: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!key) return fn();
    if (key.length > 200) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be at most 200 characters');
    const hash = createHash('sha256').update(JSON.stringify(requestFingerprint)).digest('hex');
    const claim = await this.idem.claim(ctx, operation, key, hash);
    if (claim.state === 'replay') return claim.response as T;
    if (claim.state === 'mismatch') throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
    if (claim.state === 'in_progress') throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
    try {
      const result = await fn();
      await this.idem.complete(ctx, operation, key, result);
      return result;
    } catch (e) {
      await this.idem.release(ctx, operation, key).catch(() => undefined);
      throw e;
    }
  }

  // ---------- use cases ----------

  async create(ctx: RequestContext, websiteId: string, body: CreateBody, idempotencyKey?: string): Promise<LandingPageDto> {
    return this.withIdempotency(ctx, `create:${websiteId}`, idempotencyKey, { websiteId, body }, async () => {
      const slug = body.slug ?? normalizeSlug(slugify(body.name));
      if (!slug) throw badRequest('INVALID_SLUG', 'A slug could not be derived from the name; supply one');
      await this.integrations.website.assertWebsiteInScope(ctx, websiteId);
      if (await this.pages.slugTaken(ctx, websiteId, slug)) throw slugConflict();

      // Downstream call happens outside any DB transaction.
      const { documentId } = await this.integrations.documents.createDraft(ctx, {
        websiteId,
        name: body.name,
        idempotencyKey: idempotencyKey ?? `create-${ctx.requestId}`,
      });

      let row: LandingPageRow;
      try {
        row = await this.pages.insert(ctx, { websiteId, name: body.name, slug, documentId });
      } catch (e) {
        await this.discardOrphanDraft(ctx, documentId);
        throw isUniqueViolation(e) ? slugConflict() : e;
      }
      await this.recordAudit(ctx, 'LANDING_PAGE_CREATED', row.id, { websiteId, slug });
      return toDto(row);
    });
  }

  async list(ctx: RequestContext, websiteId: string, q: ListQuery) {
    await this.integrations.website.assertWebsiteInScope(ctx, websiteId);
    const filters: ListFilters = {
      lifecycleStatus: q.lifecycleStatus,
      publicationStatus: q.publicationStatus,
      q: q.q,
      sortBy: q.sortBy,
      order: q.order,
      limit: q.limit,
      cursor: q.cursor ? decodeCursor(q.cursor, q.sortBy, q.order) : undefined,
    };
    let rows;
    try {
      rows = await this.pages.list(ctx, websiteId, filters);
    } catch (e) {
      // 22xxx = data exception (e.g. an impossible date inside an otherwise well-formed cursor).
      if (filters.cursor && /^22/.test((e as { code?: string })?.code ?? '')) {
        throw badRequest('INVALID_CURSOR', 'cursor is invalid or does not match the requested sort');
      }
      throw e;
    }
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ s: q.sortBy, o: q.order, v: last.sort_value, id: last.id }) : null;
    return { items: items.map(toDto), nextCursor, limit: q.limit };
  }

  async get(ctx: RequestContext, id: string): Promise<LandingPageDto> {
    return toDto(await this.load(ctx, id));
  }

  async update(ctx: RequestContext, id: string, body: UpdateBody, ifMatch?: string): Promise<LandingPageDto> {
    const expected = parseIfMatch(ifMatch);
    const current = await this.load(ctx, id);
    if (current.lifecycle_status !== 'ACTIVE') throw conflict('LANDING_PAGE_NOT_ACTIVE', 'Archived pages cannot be modified');
    if (expected !== null && current.version !== expected) throw preconditionFailed();

    const slugChanged = body.slug !== undefined && body.slug !== current.slug;
    if (slugChanged && (await this.pages.slugTaken(ctx, current.website_id, body.slug!, id))) throw slugConflict();

    let updated: LandingPageRow | null;
    try {
      updated = await this.pages.updateMetadata(ctx, id, { name: body.name, slug: body.slug }, expected);
    } catch (e) {
      throw isUniqueViolation(e) ? slugConflict() : e;
    }
    if (!updated) {
      // Lost a race between the read above and the write: re-read to report the real cause.
      const fresh = await this.pages.findById(ctx, id);
      if (!fresh) throw notFound();
      if (fresh.lifecycle_status !== 'ACTIVE') throw conflict('LANDING_PAGE_NOT_ACTIVE', 'Archived pages cannot be modified');
      throw preconditionFailed();
    }

    if (slugChanged && current.publication_status === 'PUBLISHED') {
      // Redirects / cache / sitemap belong to Publishing; a failure here is surfaced, not hidden.
      await this.integrations.publishing.notifySlugChange(ctx, { pageId: id, oldSlug: current.slug, newSlug: updated.slug });
    }
    await this.recordAudit(ctx, slugChanged ? 'LANDING_PAGE_SLUG_CHANGED' : 'LANDING_PAGE_RENAMED', id, {
      before: { name: current.name, slug: current.slug },
      after: { name: updated.name, slug: updated.slug },
    });
    return toDto(updated);
  }

  async duplicate(ctx: RequestContext, id: string, body: DuplicateBody, idempotencyKey?: string): Promise<LandingPageDto> {
    return this.withIdempotency(ctx, `duplicate:${id}`, idempotencyKey, { id, body }, async () => {
      const source = await this.load(ctx, id);
      if (source.lifecycle_status !== 'ACTIVE') throw conflict('LANDING_PAGE_NOT_ACTIVE', 'Archived pages cannot be duplicated');

      const name = (body.name ?? `${source.name} - Copy`).slice(0, 160);
      // Truncate the base (not the suffix) so a 180-char slug still ends in a clean "-copy".
      const slug = body.slug ?? `${source.slug.slice(0, 175).replace(/-+$/, '')}-copy`;
      if (await this.pages.slugTaken(ctx, source.website_id, slug)) throw slugConflict();

      const { documentId } = await this.integrations.documents.duplicateDraft(ctx, {
        sourceDocumentId: source.document_id,
        name,
        idempotencyKey: idempotencyKey ?? `duplicate-${ctx.requestId}`,
      });

      let row: LandingPageRow;
      try {
        // New identity, unpublished, no inherited publication state.
        row = await this.pages.insert(ctx, { websiteId: source.website_id, name, slug, documentId });
      } catch (e) {
        await this.discardOrphanDraft(ctx, documentId);
        throw isUniqueViolation(e) ? slugConflict() : e;
      }
      await this.recordAudit(ctx, 'LANDING_PAGE_DUPLICATED', row.id, { sourceId: id, slug });
      return toDto(row);
    });
  }

  async publish(ctx: RequestContext, id: string, idempotencyKey?: string): Promise<LandingPageDto> {
    return this.withIdempotency(ctx, `publish:${id}`, idempotencyKey, { id, action: 'publish' }, async () => {
      const page = await this.load(ctx, id);
      if (page.lifecycle_status !== 'ACTIVE') throw conflict('LANDING_PAGE_NOT_ACTIVE', 'Archived pages cannot be published');

      const result = await this.integrations.publishing.publish(ctx, {
        pageId: id,
        documentId: page.document_id,
        idempotencyKey: idempotencyKey ?? `publish-${ctx.requestId}`,
      });
      // Record only what Publishing confirmed; never claim PUBLISHED on our own.
      const updated = await this.pages.setPublication(ctx, id, {
        publicationStatus: result.publicationStatus,
        publishedRevisionId: result.publishedRevisionId,
        hasUnpublishedChanges: result.publicationStatus === 'PUBLISHED' ? false : page.has_unpublished_changes,
      });
      if (!updated) throw notFound();
      await this.recordAudit(ctx, 'LANDING_PAGE_PUBLISH_REQUESTED', id, { result: result.publicationStatus });
      return toDto(updated);
    });
  }

  async unpublish(ctx: RequestContext, id: string, idempotencyKey?: string): Promise<LandingPageDto> {
    return this.withIdempotency(ctx, `unpublish:${id}`, idempotencyKey, { id, action: 'unpublish' }, async () => {
      const page = await this.load(ctx, id);
      if (page.publication_status === 'UNPUBLISHED') {
        throw conflict('INVALID_LIFECYCLE_TRANSITION', 'The landing page is not published');
      }
      const result = await this.integrations.publishing.unpublish(ctx, {
        pageId: id,
        documentId: page.document_id,
        idempotencyKey: idempotencyKey ?? `unpublish-${ctx.requestId}`,
      });
      const updated = await this.pages.setPublication(ctx, id, {
        publicationStatus: result.publicationStatus,
        publishedRevisionId: result.publicationStatus === 'UNPUBLISHED' ? null : page.published_revision_id,
        hasUnpublishedChanges: true,
      });
      if (!updated) throw notFound();
      await this.recordAudit(ctx, 'LANDING_PAGE_UNPUBLISH_REQUESTED', id, { result: result.publicationStatus });
      return toDto(updated);
    });
  }

  /** DELETE policy: soft-delete (tombstone) with audit trail; a live page is unpublished first. */
  async remove(ctx: RequestContext, id: string): Promise<{ id: string; deleted: true }> {
    const page = await this.load(ctx, id);
    if (page.publication_status !== 'UNPUBLISHED') {
      const result = await this.integrations.publishing.unpublish(ctx, {
        pageId: id,
        documentId: page.document_id,
        idempotencyKey: `delete-${id}-${page.version}`,
      });
      if (result.publicationStatus !== 'UNPUBLISHED') {
        throw unavailable('UNPUBLISH_NOT_CONFIRMED', 'Publishing has not confirmed the unpublish; the page was not deleted');
      }
    }
    const deleted = await this.pages.softDelete(ctx, id);
    if (!deleted) throw notFound();
    await this.recordAudit(ctx, 'LANDING_PAGE_DELETED', id, { slug: page.slug });
    return { id, deleted: true };
  }
}

