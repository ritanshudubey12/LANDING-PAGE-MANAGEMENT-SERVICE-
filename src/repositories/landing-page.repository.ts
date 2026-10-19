import type { Pool, PoolClient } from 'pg';
import type { LandingPageRow, LifecycleStatus, PublicationStatus, RequestContext } from '../types';

type Db = Pool | PoolClient;

export const SORT_COLUMNS = {
  createdAt: { column: 'created_at', cast: 'timestamptz' },
  updatedAt: { column: 'updated_at', cast: 'timestamptz' },
  name: { column: 'name', cast: 'text' },
} as const;
export type SortBy = keyof typeof SORT_COLUMNS;

export type ListFilters = {
  lifecycleStatus?: LifecycleStatus;
  publicationStatus?: PublicationStatus;
  q?: string;
  sortBy: SortBy;
  order: 'asc' | 'desc';
  limit: number;
  cursor?: { v: string; id: string };
};

export type ListedRow = LandingPageRow & { sort_value: string };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class LandingPageRepository {
  constructor(private readonly db: Db) {}

  async insert(
    ctx: RequestContext,
    input: { websiteId: string; name: string; slug: string; documentId: string },
  ): Promise<LandingPageRow> {
    const { rows } = await this.db.query<LandingPageRow>(
      `INSERT INTO landing_pages
         (tenant_id, organization_id, website_id, name, slug, document_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING *`,
      [ctx.tenantId, ctx.organizationId, input.websiteId, input.name, input.slug, input.documentId, ctx.userId],
    );
    return rows[0];
  }

  async slugTaken(ctx: RequestContext, websiteId: string, slug: string, excludeId?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM landing_pages
        WHERE tenant_id = $1 AND organization_id = $2 AND website_id = $3
          AND lower(slug) = lower($4) AND deleted_at IS NULL AND lifecycle_status = 'ACTIVE'
          AND ($5::bigint IS NULL OR id <> $5::bigint)
        LIMIT 1`,
      [ctx.tenantId, ctx.organizationId, websiteId, slug, excludeId ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  async findById(ctx: RequestContext, id: string): Promise<LandingPageRow | null> {
    const { rows } = await this.db.query<LandingPageRow>(
      `SELECT * FROM landing_pages
        WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND deleted_at IS NULL`,
      [id, ctx.tenantId, ctx.organizationId],
    );
    return rows[0] ?? null;
  }

  async list(ctx: RequestContext, websiteId: string, f: ListFilters): Promise<ListedRow[]> {
    const sort = SORT_COLUMNS[f.sortBy]; // allowlisted: user input never reaches SQL text
    const dir = f.order === 'asc' ? 'ASC' : 'DESC';
    const cmp = f.order === 'asc' ? '>' : '<';
    const params: unknown[] = [ctx.tenantId, ctx.organizationId, websiteId];
    const where = ['tenant_id = $1', 'organization_id = $2', 'website_id = $3', 'deleted_at IS NULL'];

    if (f.lifecycleStatus) {
      params.push(f.lifecycleStatus);
      where.push(`lifecycle_status = $${params.length}`);
    }
    if (f.publicationStatus) {
      params.push(f.publicationStatus);
      where.push(`publication_status = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${escapeLike(f.q)}%`);
      where.push(`(name ILIKE $${params.length} ESCAPE '\\' OR slug ILIKE $${params.length} ESCAPE '\\')`);
    }
    if (f.cursor) {
      params.push(f.cursor.v, f.cursor.id);
      where.push(`(${sort.column}, id) ${cmp} ($${params.length - 1}::${sort.cast}, $${params.length}::bigint)`);
    }
    params.push(f.limit + 1);

    const { rows } = await this.db.query<ListedRow>(
      `SELECT *, ${sort.column}::text AS sort_value
         FROM landing_pages
        WHERE ${where.join(' AND ')}
        ORDER BY ${sort.column} ${dir}, id ${dir}
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  /** Optimistic update. Returns null when no row matched (caller distinguishes 404/409/412). */
  async updateMetadata(
    ctx: RequestContext,
    id: string,
    patch: { name?: string; slug?: string },
    expectedVersion: number | null,
  ): Promise<LandingPageRow | null> {
    const { rows } = await this.db.query<LandingPageRow>(
      `UPDATE landing_pages
          SET name = COALESCE($4, name),
              slug = COALESCE($5, slug),
              version = version + 1,
              updated_by = $6,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND organization_id = $3
          AND deleted_at IS NULL AND lifecycle_status = 'ACTIVE'
          AND ($7::int IS NULL OR version = $7::int)
        RETURNING *`,
      [id, ctx.tenantId, ctx.organizationId, patch.name ?? null, patch.slug ?? null, ctx.userId, expectedVersion],
    );
    return rows[0] ?? null;
  }

  async setPublication(
    ctx: RequestContext,
    id: string,
    state: { publicationStatus: PublicationStatus; publishedRevisionId: string | null; hasUnpublishedChanges: boolean },
  ): Promise<LandingPageRow | null> {
    const { rows } = await this.db.query<LandingPageRow>(
      `UPDATE landing_pages
          SET publication_status = $4,
              published_revision_id = $5,
              has_unpublished_changes = $6,
              version = version + 1,
              updated_by = $7,
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [id, ctx.tenantId, ctx.organizationId, state.publicationStatus, state.publishedRevisionId, state.hasUnpublishedChanges, ctx.userId],
    );
    return rows[0] ?? null;
  }

  async softDelete(ctx: RequestContext, id: string): Promise<LandingPageRow | null> {
    const { rows } = await this.db.query<LandingPageRow>(
      `UPDATE landing_pages
          SET deleted_at = NOW(), archived_at = COALESCE(archived_at, NOW()),
              lifecycle_status = 'ARCHIVED', version = version + 1,
              updated_by = $4, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND organization_id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [id, ctx.tenantId, ctx.organizationId, ctx.userId],
    );
    return rows[0] ?? null;
  }
}
