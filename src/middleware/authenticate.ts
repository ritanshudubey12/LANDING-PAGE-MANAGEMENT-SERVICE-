import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../lib/errors';

const digest = (v: string) => createHash('sha256').update(v).digest();

/**
 * Topology B: this service is private and only accepts the gateway's service-to-service Bearer credential.
 * Constant-time comparison; the credential is never logged.
 */
export function authenticate(expectedToken: string) {
  const expected = digest(expectedToken);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return next(unauthorized());
    }
    next();
  };
}
