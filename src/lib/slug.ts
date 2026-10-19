export const SLUG_MAX = 180;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slug policy: trimmed, lowercase ASCII letters/digits separated by single hyphens, max 180 chars. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= 1 && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);
}

/** Derive a slug from a display name (accents stripped, non-alphanumerics become hyphens). */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}
