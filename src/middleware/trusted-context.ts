import type { NextFunction, Request, Response } from 'express';
import { badRequest } from '../lib/errors';
import { isBigIntId } from '../lib/bigint';
import type { RequestContext } from '../types';

function requiredId(req: Request, header: string): string {
  const v = req.header(header);
  if (!v) throw badRequest('MISSING_CONTEXT_HEADER', `${header} header is required`);
  if (!isBigIntId(v)) throw badRequest('INVALID_CONTEXT_HEADER', `${header} must be a positive BIGINT decimal string`);
  return v;
}

/**
 * Builds the immutable request context ONCE, after the caller has been authenticated.
 * Only the authenticated gateway can reach this point, so these headers are trusted for scope;
 * they are never read from the JSON body.
 */
export function trustedContext(req: Request, res: Response, next: NextFunction) {
  try {
    const softwareHeader = req.header('x-software-id');
    if (softwareHeader !== undefined && !isBigIntId(softwareHeader)) {
      throw badRequest('INVALID_CONTEXT_HEADER', 'X-Software-Id must be a positive BIGINT decimal string');
    }
    const permissions = (req.header('x-permissions') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const ctx: RequestContext = {
      tenantId: requiredId(req, 'x-tenant-id'),
      organizationId: requiredId(req, 'x-organization-id'),
      userId: requiredId(req, 'x-user-id'),
      softwareId: softwareHeader,
      requestId: res.locals.requestId,
      permissions,
    };
    res.locals.ctx = Object.freeze(ctx);
    next();
  } catch (e) {
    next(e);
  }
}
