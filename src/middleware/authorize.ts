import type { NextFunction, Request, Response } from 'express';
import { forbidden } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { getCtx } from '../types';

export type Permission =
  | 'landing-page:create'
  | 'landing-page:read'
  | 'landing-page:update'
  | 'landing-page:duplicate'
  | 'landing-page:delete'
  | 'landing-page:publish';

export function authorize(permission: Permission, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = getCtx(res);
    if (!ctx.permissions.includes(permission) && !ctx.permissions.includes('*')) {
      logger.warn('permission_denied', {
        requestId: ctx.requestId,
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        permission,
        route: req.path,
      });
      return next(forbidden());
    }
    next();
  };
}
