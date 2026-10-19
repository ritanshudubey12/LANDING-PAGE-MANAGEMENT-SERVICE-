CREATE TABLE landing_pages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  website_id BIGINT NOT NULL,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(180) NOT NULL,
  lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  -- Cached from the authoritative Publishing service (never set by API callers).
  publication_status VARCHAR(24) NOT NULL DEFAULT 'UNPUBLISHED',
  has_unpublished_changes BOOLEAN NOT NULL DEFAULT TRUE,
  -- References to other services; deliberately no cross-service foreign keys.
  document_id BIGINT NOT NULL,
  published_revision_id BIGINT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by BIGINT NOT NULL,
  updated_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ NULL,
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT landing_pages_lifecycle_check
    CHECK (lifecycle_status IN ('ACTIVE', 'ARCHIVED')),
  CONSTRAINT landing_pages_publication_check
    CHECK (publication_status IN ('UNPUBLISHED','PUBLISHED','PUBLISH_PENDING','UNPUBLISH_PENDING','FAILED'))
);

-- Slug policy: ACTIVE, non-deleted pages reserve their slug per website within tenant + organization.
-- Archived and soft-deleted pages release their slug.
CREATE UNIQUE INDEX landing_pages_slug_active_uq
  ON landing_pages (tenant_id, organization_id, website_id, lower(slug))
  WHERE deleted_at IS NULL AND lifecycle_status = 'ACTIVE';

CREATE INDEX landing_pages_scope_created_idx
  ON landing_pages (tenant_id, organization_id, website_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE idempotency_keys (
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  operation VARCHAR(40) NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_body JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, organization_id, user_id, operation, idempotency_key)
);

CREATE TABLE audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  action VARCHAR(60) NOT NULL,
  resource_id BIGINT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_log_scope_idx ON audit_log (tenant_id, organization_id, created_at DESC);

-- Durable record of cross-service cleanup that must be retried (e.g. orphaned draft documents).
CREATE TABLE workflow_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  tenant_id BIGINT NOT NULL,
  organization_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_operations_status_check CHECK (status IN ('PENDING','DONE','FAILED'))
);
CREATE INDEX workflow_operations_pending_idx ON workflow_operations (status, created_at);

-- Local-development stand-ins used ONLY by INTEGRATIONS_MODE=stub.
CREATE SEQUENCE stub_document_id_seq START 7001;
CREATE SEQUENCE stub_revision_id_seq START 8001;
