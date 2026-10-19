export const BIGINT_MAX = 9223372036854775807n; // PostgreSQL BIGINT upper bound

/** Strict decimal BIGINT string: no sign, decimals, exponent, whitespace, leading zeros, or overflow. */
export function isBigIntId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BIGINT_MAX;
}
