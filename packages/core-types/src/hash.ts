import { createHash } from 'node:crypto';

export const sha256 = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Canonical JSON: object keys sorted recursively, so that two structurally
 * equal values always produce the same digest. Used for `policyHash`, block
 * content hashes and the contract-freeze check.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const hashCanonical = (value: unknown): string => sha256(canonicalJson(value));
