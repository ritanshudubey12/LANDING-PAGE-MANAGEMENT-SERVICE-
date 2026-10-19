import { Router } from 'express';
import type { Logger } from '../lib/logger';
import { authorize } from '../middleware/authorize';
import type { createController } from '../controllers/landing-page.controller';

export function landingPageRoutes(c: ReturnType<typeof createController>, logger: Logger): Router {
  const r = Router();
  r.post('/websites/:websiteId/landing-pages', authorize('landing-page:create', logger), c.create);
  r.get('/websites/:websiteId/landing-pages', authorize('landing-page:read', logger), c.list);
  r.get('/landing-pages/:landingPageId', authorize('landing-page:read', logger), c.get);
  r.patch('/landing-pages/:landingPageId', authorize('landing-page:update', logger), c.update);
  r.put('/landing-pages/:landingPageId', authorize('landing-page:update', logger), c.replace);
  r.post('/landing-pages/:landingPageId/duplicate', authorize('landing-page:duplicate', logger), c.duplicate);
  r.delete('/landing-pages/:landingPageId', authorize('landing-page:delete', logger), c.remove);
  r.post('/landing-pages/:landingPageId/publish', authorize('landing-page:publish', logger), c.publish);
  r.post('/landing-pages/:landingPageId/unpublish', authorize('landing-page:publish', logger), c.unpublish);
  return r;
}
