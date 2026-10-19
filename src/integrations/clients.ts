import type { Pool } from 'pg';
import { unavailable } from '../lib/errors';
import type { PublicationStatus, RequestContext } from '../types';

/**
 * Adapter interfaces for services this microservice does NOT own.
 * The real Document/Draft-Version and Publishing API contracts are unconfirmed (report section 16),
 * so no endpoint paths are invented here: `stub` mode provides local-development behaviour and
 * `http` mode fails closed with 503 until a contract is implemented.
 */
export interface WebsiteClient {
  /** Verify the website exists within the caller's tenant + organization. Throws 404 otherwise. */
  assertWebsiteInScope(ctx: RequestContext, websiteId: string): Promise<void>;
}

export interface DocumentDraftClient {
  createDraft(ctx: RequestContext, input: { websiteId: string; name: string; idempotencyKey: string }): Promise<{ documentId: string }>;
  /** Independent deep copy of the source draft; must not share mutable state. */
  duplicateDraft(ctx: RequestContext, input: { sourceDocumentId: string; name: string; idempotencyKey: string }): Promise<{ documentId: string }>;
  discardDraft(ctx: RequestContext, documentId: string): Promise<void>;
}

export type PublishResult = {
  publicationStatus: PublicationStatus;
  publishedRevisionId: string | null;
};

export interface PublishingClient {
  publish(ctx: RequestContext, input: { pageId: string; documentId: string; idempotencyKey: string }): Promise<PublishResult>;
  unpublish(ctx: RequestContext, input: { pageId: string; documentId: string; idempotencyKey: string }): Promise<PublishResult>;
  /** Redirect history, cache invalidation and sitemap updates for a published page whose slug changed. */
  notifySlugChange(ctx: RequestContext, input: { pageId: string; oldSlug: string; newSlug: string }): Promise<void>;
}

export type Integrations = {
  website: WebsiteClient;
  documents: DocumentDraftClient;
  publishing: PublishingClient;
  /** Readiness of required downstream dependencies. */
  ready(): Promise<boolean>;
};

/** Local-development adapters. Never allowed in production (see config). */
export function createStubIntegrations(pool: Pool): Integrations {
  const nextVal = async (seq: 'stub_document_id_seq' | 'stub_revision_id_seq') =>
    (await pool.query<{ v: string }>(`SELECT nextval('${seq}')::text AS v`)).rows[0].v;

  return {
    website: { assertWebsiteInScope: async () => undefined },
    documents: {
      createDraft: async () => ({ documentId: await nextVal('stub_document_id_seq') }),
      duplicateDraft: async () => ({ documentId: await nextVal('stub_document_id_seq') }),
      discardDraft: async () => undefined,
    },
    publishing: {
      publish: async () => ({ publicationStatus: 'PUBLISHED', publishedRevisionId: await nextVal('stub_revision_id_seq') }),
      unpublish: async () => ({ publicationStatus: 'UNPUBLISHED', publishedRevisionId: null }),
      notifySlugChange: async () => undefined,
    },
    ready: async () => true,
  };
}

/** Placeholder until the real service contracts are confirmed: fails closed rather than guessing. */
export function createHttpIntegrations(): Integrations {
  const notConfigured = () => {
    throw unavailable('INTEGRATION_CONTRACT_NOT_CONFIGURED', 'Downstream service contract is not configured');
  };
  return {
    website: { assertWebsiteInScope: async () => notConfigured() },
    documents: { createDraft: async () => notConfigured(), duplicateDraft: async () => notConfigured(), discardDraft: async () => notConfigured() },
    publishing: { publish: async () => notConfigured(), unpublish: async () => notConfigured(), notifySlugChange: async () => notConfigured() },
    ready: async () => false,
  };
}
