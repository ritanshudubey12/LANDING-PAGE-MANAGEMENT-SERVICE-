import { describe, expect, it } from 'vitest';
import { isBigIntId } from '../../src/lib/bigint';
import { isValidSlug, normalizeSlug, slugify } from '../../src/lib/slug';
import { loadConfig } from '../../src/config/env';
import { createLogger } from '../../src/lib/logger';
import { parseIfMatch } from '../../src/services/landing-page.service';

describe('BIGINT id validation', () => {
  it('accepts valid decimal strings including > 2^53-1 and the BIGINT max', () => {
    expect(isBigIntId('1')).toBe(true);
    expect(isBigIntId('9007199254740993')).toBe(true);
    expect(isBigIntId('9223372036854775807')).toBe(true);
  });
  it.each(['', '0', '-1', '+1', '1.5', '1e3', ' 1', '1 ', '01', '9223372036854775808', 'abc', '99999999999999999999'])(
    'rejects %j',
    (v) => expect(isBigIntId(v)).toBe(false),
  );
  it('rejects non-strings', () => {
    expect(isBigIntId(5)).toBe(false);
    expect(isBigIntId(undefined)).toBe(false);
  });
});

describe('slug policy', () => {
  it('normalizes case and whitespace', () => expect(normalizeSlug('  Spring-Sale ')).toBe('spring-sale'));
  it.each(['spring-sale', 'a', 'a1-b2'])('accepts %s', (s) => expect(isValidSlug(s)).toBe(true));
  it.each(['', '-a', 'a-', 'a--b', 'a b', 'a_b', 'é', 'a/b', 'x'.repeat(181)])('rejects %j', (s) => expect(isValidSlug(s)).toBe(false));
  it('slugifies names', () => expect(slugify('Spring Campaign — Café!')).toBe('spring-campaign-cafe'));
});

describe('If-Match parsing', () => {
  it('parses page versions and wildcard', () => {
    expect(parseIfMatch('"page-v3"')).toBe(3);
    expect(parseIfMatch('W/"page-v7"')).toBe(7);
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('*')).toBeNull();
  });
  it('rejects malformed values', () => expect(() => parseIfMatch('nonsense')).toThrow());
});

describe('config', () => {
  const base = { DATABASE_URL: 'postgresql://x', INTERNAL_SERVICE_TOKEN: 'a-sufficiently-long-token' } as NodeJS.ProcessEnv;
  it('applies defaults', () => expect(loadConfig(base).PORT).toBe(4027));
  it('rejects a short internal token', () => expect(() => loadConfig({ ...base, INTERNAL_SERVICE_TOKEN: 'short' })).toThrow());
  it('refuses stub integrations in production', () =>
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/stub/));
  it('refuses placeholder tokens in production', () =>
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', INTEGRATIONS_MODE: 'http', INTERNAL_SERVICE_TOKEN: 'replace_in_secret_manager' }),
    ).toThrow(/placeholder/));
});

describe('logger redaction', () => {
  it('redacts sensitive keys', () => {
    const lines: string[] = [];
    createLogger('info', (l) => lines.push(l)).info('x', { authorization: 'Bearer secret', internalToken: 'abc', ok: 1 });
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain('abc');
    expect(JSON.parse(lines[0]).ok).toBe(1);
  });
});
