import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError, unprocessable } from '../lib/errors';
import { createBody, duplicateBody, idSchema, listQuery, replaceBody, updateBody } from '../schemas/landing-page.schema';
import { etagFor, type LandingPageService } from '../services/landing-page.service';
import { getCtx } from '../types';

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw unprocessable(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

function id(req: Request, name: string): string {
  const r = idSchema.safeParse(req.params[name]);
  if (!r.success) throw new AppError(400, 'INVALID_ID', `${name} must be a positive BIGINT decimal string`);
  return r.data;
}

const handler =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

const ok = (res: Response, data: unknown, extra: Record<string, unknown> = {}) =>
  res.status(200).json({ success: true, data, ...extra, requestId: res.locals.requestId });

const okPage = (res: Response, dto: { version: number }) => {
  res.setHeader('ETag', etagFor(dto.version));
  return ok(res, dto);
};

export function createController(service: LandingPageService) {
  return {
    create: handler(async (req, res) => {
      const dto = await service.create(getCtx(res), id(req, 'websiteId'), parse(createBody, req.body ?? {}), req.header('idempotency-key'));
      okPage(res, dto);
    }),
    list: handler(async (req, res) => {
      const { items, nextCursor, limit } = await service.list(getCtx(res), id(req, 'websiteId'), parse(listQuery, req.query));
      ok(res, items, { meta: { limit, nextCursor } });
    }),
    get: handler(async (req, res) => {
      okPage(res, await service.get(getCtx(res), id(req, 'landingPageId')));
    }),
    update: handler(async (req, res) => {
      okPage(res, await service.update(getCtx(res), id(req, 'landingPageId'), parse(updateBody, req.body ?? {}), req.header('if-match')));
    }),
    replace: handler(async (req, res) => {
      okPage(res, await service.update(getCtx(res), id(req, 'landingPageId'), parse(replaceBody, req.body ?? {}), req.header('if-match')));
    }),
    duplicate: handler(async (req, res) => {
      okPage(
        res,
        await service.duplicate(getCtx(res), id(req, 'landingPageId'), parse(duplicateBody, req.body ?? {}), req.header('idempotency-key')),
      );
    }),
    remove: handler(async (req, res) => {
      ok(res, await service.remove(getCtx(res), id(req, 'landingPageId')));
    }),
    publish: handler(async (req, res) => {
      okPage(res, await service.publish(getCtx(res), id(req, 'landingPageId'), req.header('idempotency-key')));
    }),
    unpublish: handler(async (req, res) => {
      okPage(res, await service.unpublish(getCtx(res), id(req, 'landingPageId'), req.header('idempotency-key')));
    }),
  };
}
