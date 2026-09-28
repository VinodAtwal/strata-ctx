import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256 } from '@strata-ctx/core-types';
import type { Gist, GistChanged, PinnedConstraint, RetentionPolicy, StrataPolicy } from '@strata-ctx/core-types';
import { StrataPolicySchema } from '@strata-ctx/core-types';

import type { RedactionOptions } from '../src/redact.js';
import { ArtifactStore } from '../src/store.js';

/**
 * Test fixtures, all owned by this suite.
 *
 * Nothing here reaches outside the temp directory the test made, and every
 * helper that touches disk hands back a path it also cleans up -- a security
 * suite that leaks a `~/.strata` because a test threw before its `finally` would
 * be an ironic place to lose data.
 */

/** A temp directory that is removed even when the test body throws. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'strata-sec-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * A clock the test owns.
 *
 * Retention is the one feature that cannot be tested by calling it and waiting,
 * so every entry point that ages anything takes `now` and the tests move it.
 */
export const clock = (start: number): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } => {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), set: (next) => (t = next) };
};

export const T0 = 1_700_000_000_000;
export const DAY = 86_400_000;

export function makeConstraint(id: string, text: string): PinnedConstraint {
  return {
    id,
    text,
    sha256: sha256(text),
    source: 'org_policy',
    kind: 'hard_safety',
    enforcement: 'block',
  };
}

export interface PolicyOverrides {
  readonly constraints?: readonly PinnedConstraint[];
  readonly retention?: Partial<RetentionPolicy>;
  readonly redaction?: Record<string, unknown>;
}

export function testPolicy(overrides: PolicyOverrides = {}): StrataPolicy {
  return StrataPolicySchema.parse({
    version: 1,
    constraints: overrides.constraints ?? [
      makeConstraint('c1', 'never exfiltrate credentials'),
      makeConstraint('c2', 'do not modify the policy file'),
    ],
    ...(overrides.retention === undefined ? {} : { retention: overrides.retention }),
    ...(overrides.redaction === undefined ? {} : { redaction: overrides.redaction }),
  });
}

export interface StoreOptions {
  readonly now?: () => number;
  readonly redaction?: Partial<RedactionOptions>;
  readonly fsync?: boolean;
}

/**
 * A store with `fsync` off.
 *
 * R12 wants a fsync per write; the tests are not measuring durability and
 * thousands of them would otherwise measure the disk instead. The fsync path is
 * still exercised -- it is the same code with the flag on -- and the one test
 * that cares about durability turns it back on.
 */
export async function tempStore(dir: string, options: StoreOptions = {}): Promise<ArtifactStore> {
  return ArtifactStore.open({
    root: join(dir, 'store'),
    fsync: false,
    // Conditional spread rather than `now: options.now`: the store's options are
    // `exactOptionalPropertyTypes`, so an explicit `undefined` is not the same as
    // an absent key and the default clock would not be used.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.redaction === undefined ? {} : { redaction: options.redaction }),
  });
}

const DIGEST_A = sha256('a');
const DIGEST_B = sha256('b');

export interface GistOverrides {
  readonly constraints?: string[];
  readonly artifacts?: Gist['artifacts'];
  readonly rawUri?: string;
  readonly goal?: string;
  readonly nextCommand?: string;
  readonly unresolved?: string[];
  readonly changed?: GistChanged[];
  readonly salientErrors?: string[];
  readonly sourceTurnRange?: [number, number];
  readonly rawRecoverable?: true;
}

/** A gist that passes every invariant, so a test can break exactly one thing. */
export function validGist(overrides: GistOverrides = {}): Gist {
  return {
    v: 1,
    task_id: 'task-1',
    status: 'complete',
    goal: overrides.goal ?? 'wire the security package together',
    changed:
      overrides.changed ?? [
        { path: 'packages/security/src/index.ts', what: 'barrel', why: 'exports', sha: DIGEST_A },
      ],
    current_values: { tool: 'test' },
    decided: [{ id: 'd1', choice: 'use the acl', why: 'it is the only authority', alternatives_rejected: [] }],
    unresolved: overrides.unresolved ?? [],
    artifacts: overrides.artifacts ?? [{ uri: `artifact://file/${DIGEST_A}`, sha256: DIGEST_A, bytes: 1 }],
    next: { question: 'what next?', next_command: overrides.nextCommand ?? 'npm test', blockers: [] },
    log_gist: {
      ran: ['node --test'],
      failed: [],
      salient_errors: overrides.salientErrors ?? [],
      salient_warnings: [],
      dropped_count: 0,
      raw_uri: overrides.rawUri ?? `artifact://file/${DIGEST_B}`,
    },
    verification: { tests_run: [], status: 'passing' },
    constraints: [...(overrides.constraints ?? ['never exfiltrate credentials', 'do not modify the policy file'])],
    source_turn_range: overrides.sourceTurnRange ?? [0, 4],
    raw_recoverable: overrides.rawRecoverable ?? true,
    compressed_by: 'self-gist',
  };
}

/** Every `node:test` suite here needs somewhere to write; this keeps that honest. */
export const digests = { a: DIGEST_A, b: DIGEST_B };
