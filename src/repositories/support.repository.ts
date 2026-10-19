import type { Pool } from 'pg';
import type { RequestContext } from '../types';

export type IdempotencyClaim =
  | { state: 'claimed' }
  | { state: 'replay'; response: unknown }
  | { state: 'in_progress' }
  | { state: 'mismatch' };

export class IdempotencyRepository {
  constructor(private readonly pool: Pool) {}

  async claim(ctx: RequestContext, operation: string, key: string, requestHash: string): Promise<IdempotencyClaim> {
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_keys (tenant_id, organization_id, user_id, operation, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [ctx.tenantId, ctx.organizationId, ctx.userId, operation, key, requestHash],
    );
    if ((inserted.rowCount ?? 0) > 0) return { state: 'claimed' };

    const { rows } = await this.pool.query<{ request_hash: string; response_body: unknown | null }>(
      `SELECT request_hash, response_body FROM idempotency_keys
        WHERE tenant_id = $1 AND organization_id = $2 AND user_id = $3 AND operation = $4 AND idempotency_key = $5`,
      [ctx.tenantId, ctx.organizationId, ctx.userId, operation, key],
    );
    const row = rows[0];
    if (!row) return { state: 'in_progress' };
    if (row.request_hash !== requestHash) return { state: 'mismatch' };
    return row.response_body === null ? { state: 'in_progress' } : { state: 'replay', response: row.response_body };
  }

  async complete(ctx: RequestContext, operation: string, key: string, response: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys SET response_body = $6::jsonb
        WHERE tenant_id = $1 AND organization_id = $2 AND user_id = $3 AND operation = $4 AND idempotency_key = $5`,
      [ctx.tenantId, ctx.organizationId, ctx.userId, operation, key, JSON.stringify(response)],
    );
  }

  /** Drop completed keys after 24h and abandoned in-flight claims (crashed requests) after 5 minutes. */
  async purgeExpired(): Promise<number> {
    const r = await this.pool.query(
      `DELETE FROM idempotency_keys
        WHERE (response_body IS NOT NULL AND created_at < NOW() - INTERVAL '24 hours')
           OR (response_body IS NULL AND created_at < NOW() - INTERVAL '5 minutes')`,
    );
    return r.rowCount ?? 0;
  }

  async release(ctx: RequestContext, operation: string, key: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_keys
        WHERE tenant_id = $1 AND organization_id = $2 AND user_id = $3 AND operation = $4 AND idempotency_key = $5
          AND response_body IS NULL`,
      [ctx.tenantId, ctx.organizationId, ctx.userId, operation, key],
    );
  }
}

export class AuditRepository {
  constructor(private readonly pool: Pool) {}

  async record(ctx: RequestContext, action: string, resourceId: string | null, details: Record<string, unknown> = {}) {
    await this.pool.query(
      `INSERT INTO audit_log (tenant_id, organization_id, user_id, request_id, action, resource_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [ctx.tenantId, ctx.organizationId, ctx.userId, ctx.requestId, action, resourceId, JSON.stringify(details)],
    );
  }
}

export type PendingOperation = {
  id: string;
  tenant_id: string;
  organization_id: string;
  user_id: string;
  document_id: string;
  attempts: number;
};

export class WorkflowOperationRepository {
  constructor(private readonly pool: Pool) {}

  async enqueueDiscardDraft(ctx: RequestContext, documentId: string, error: string) {
    await this.pool.query(
      `INSERT INTO workflow_operations (kind, tenant_id, organization_id, user_id, document_id, last_error)
       VALUES ('DISCARD_DRAFT', $1, $2, $3, $4, $5)`,
      [ctx.tenantId, ctx.organizationId, ctx.userId, documentId, error.slice(0, 500)],
    );
  }

  async listPending(limit = 20): Promise<PendingOperation[]> {
    const { rows } = await this.pool.query<PendingOperation>(
      `SELECT id, tenant_id, organization_id, user_id, document_id, attempts
         FROM workflow_operations
        WHERE kind = 'DISCARD_DRAFT' AND status = 'PENDING'
        ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async markDone(id: string) {
    await this.pool.query(`UPDATE workflow_operations SET status = 'DONE', updated_at = NOW() WHERE id = $1`, [id]);
  }

  async markAttempt(id: string, error: string, maxAttempts = 10) {
    await this.pool.query(
      `UPDATE workflow_operations
          SET attempts = attempts + 1, last_error = $2, updated_at = NOW(),
              status = CASE WHEN attempts + 1 >= $3 THEN 'FAILED' ELSE status END
        WHERE id = $1`,
      [id, error.slice(0, 500), maxAttempts],
    );
  }
}
