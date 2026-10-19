import { z } from 'zod';
import { isBigIntId } from '../lib/bigint';
import { isValidSlug, normalizeSlug, SLUG_MAX } from '../lib/slug';

export const idSchema = z.string().refine(isBigIntId, 'must be a positive BIGINT decimal string');

const noNul = (s: string) => !s.includes('\u0000');
const NUL_MSG = 'must not contain NUL characters';

const name = z.string().trim().min(1, 'name is required').max(160).refine(noNul, NUL_MSG);
const slug = z
  .string()
  .max(SLUG_MAX + 50)
  .transform(normalizeSlug)
  .refine(isValidSlug, `slug must be 1-${SLUG_MAX} chars of lowercase letters, digits and single hyphens`);

// .strict(): tenant_id / organization_id / user_id / publication status in the body are rejected, never honoured.
export const createBody = z.object({ name, slug: slug.optional() }).strict();

export const updateBody = z
  .object({ name: name.optional(), slug: slug.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.slug !== undefined, 'at least one of name or slug is required');

// PUT = full replacement of the editable metadata: both fields are required.
export const replaceBody = z.object({ name, slug }).strict();

export const duplicateBody = z.object({ name: name.optional(), slug: slug.optional() }).strict();

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).refine(noNul, NUL_MSG).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'name']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  lifecycleStatus: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  publicationStatus: z.enum(['UNPUBLISHED', 'PUBLISHED', 'PUBLISH_PENDING', 'UNPUBLISH_PENDING', 'FAILED']).optional(),
  q: z.string().trim().min(1).max(100).refine(noNul, NUL_MSG).optional(),
});

export type CreateBody = z.infer<typeof createBody>;
export type UpdateBody = z.infer<typeof updateBody>;
export type DuplicateBody = z.infer<typeof duplicateBody>;
export type ListQuery = z.infer<typeof listQuery>;
