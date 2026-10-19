import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import type { Logger } from '../lib/logger';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, 'ROUTE_NOT_FOUND', 'Route not found'));
}

export function errorHandler(logger: Logger) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId;
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown[] = [];

    if (err instanceof AppError) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
      status = 400;
      code = 'MALFORMED_JSON';
      message = 'Request body is not valid JSON';
    } else if ((err as { type?: string })?.type === 'entity.too.large') {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
      message = 'Request body is too large';
    }

    if (status >= 500) {
      // Full detail goes to logs only; never to the client.
      logger.error('request_failed', { requestId, route: req.path, error: err instanceof Error ? err.message : String(err) });
    }
    res.status(status).json({ success: false, error: { code, message, details }, requestId });
  };
}
