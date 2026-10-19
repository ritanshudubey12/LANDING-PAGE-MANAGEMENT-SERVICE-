import type { Pool } from 'pg';
import type { Integrations } from '../integrations/clients';
import type { Logger } from '../lib/logger';
import { IdempotencyRepository, WorkflowOperationRepository } from '../repositories/support.repository';

/** Retries cross-service cleanup (orphaned draft documents) recorded by failed create/duplicate flows. */
export async function reconcileOnce(pool: Pool, integrations: Integrations, logger: Logger): Promise<number> {
  const repo = new WorkflowOperationRepository(pool);
  let done = 0;
  await new IdempotencyRepository(pool).purgeExpired();
  for (const op of await repo.listPending()) {
    try {
      await integrations.documents.discardDraft(
        { tenantId: op.tenant_id, organizationId: op.organization_id, userId: op.user_id, requestId: `reconcile-${op.id}`, permissions: [] },
        op.document_id,
      );
      await repo.markDone(op.id);
      done += 1;
    } catch (e) {
      await repo.markAttempt(op.id, String(e));
      logger.warn('reconcile_failed', { operationId: op.id, error: String(e) });
    }
  }
  return done;
}

export function startReconciler(pool: Pool, integrations: Integrations, logger: Logger, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => undefined;
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce(pool, integrations, logger);
    } catch (e) {
      logger.error('reconcile_error', { error: String(e) });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
