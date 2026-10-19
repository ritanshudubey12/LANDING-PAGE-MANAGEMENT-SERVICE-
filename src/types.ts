import type { Response } from 'express';

export type RequestContext = {
  tenantId: string; // validated BIGINT decimal string
  organizationId: string; // validated BIGINT decimal string
  userId: string; // actor ID supplied by the trusted gateway
  softwareId?: string; // validated caller/product ID
  requestId: string;
  permissions: string[];
};

export type LifecycleStatus = 'ACTIVE' | 'ARCHIVED';
export type PublicationStatus = 'UNPUBLISHED' | 'PUBLISHED' | 'PUBLISH_PENDING' | 'UNPUBLISH_PENDING' | 'FAILED';

export type LandingPageRow = {
  id: string;
  tenant_id: string;
  organization_id: string;
  website_id: string;
  name: string;
  slug: string;
  lifecycle_status: LifecycleStatus;
  publication_status: PublicationStatus;
  has_unpublished_changes: boolean;
  document_id: string;
  published_revision_id: string | null;
  version: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
};

export function getCtx(res: Response): RequestContext {
  return res.locals.ctx as RequestContext;
}
