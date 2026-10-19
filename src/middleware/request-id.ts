import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accept a well-formed inbound X-Request-Id, otherwise generate one. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const inbound = req.header('x-request-id');
  const id = inbound && SAFE_ID.test(inbound) ? inbound : `req_${randomUUID()}`;
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
