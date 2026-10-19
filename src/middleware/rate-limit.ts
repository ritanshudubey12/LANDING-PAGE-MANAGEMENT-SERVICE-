import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';

/** Small fixed-window, in-memory limiter (per client IP). Use a shared store behind multiple replicas. */
export function rateLimit(maxPerMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000);
  sweep.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60_000 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > maxPerMinute) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests'));
    }
    next();
  };
}
