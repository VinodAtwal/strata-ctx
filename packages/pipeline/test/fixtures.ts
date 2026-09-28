import type {
  BlockMeta,
  ContentBlock,
  ContextState,
  HeldBlock,
  Message,
  NonGovernanceBlock,
  NonGovernanceMessage,
  NonGovernanceTier,
  Role,
  StrataPolicy,
} from '@strata-ctx/core-types';
import { runId, sha256, StrataPolicySchema, taskId } from '@strata-ctx/core-types';

/**
 * Local fixtures for this package. Rule P2: no cross-stream test fixtures, so
 * nothing here imports another package's test directory (development §2).
 *
 * The byte caps are an order of magnitude below the defaults. A test that
 * needed a 40kB block to prove truncation would be slow and would still only
 * prove the same thing; the cap is a threshold, not a behaviour.
 *
 * ## Why `block` and `message` are *narrow*, not wide
 *
 * `block` returns `NonGovernanceBlock` and `message` returns
 * `NonGovernanceMessage`, so every fixture a lossy operator is handed is built
 * at the right width in the first place. The alternative -- building `Message`
 * and casting at the call site -- is what the previous version of this file
 * did, and it cost 81 type errors while proving nothing: the casts were exactly
 * the hole in the guarantee that `NonGovernanceMessage` exists to close.
 *
 * The one builder that is deliberately wide is `stateMessage`, and it exists
 * because a `ContextState` legitimately *does* contain governance -- that is
 * what `enforcePins` puts there. Losing the narrowing at the context boundary
 * is correct; losing it at the operator boundary would not be.
 */

export const TIER_CAPS = { tool_state: 600, episodic: 900, artifact_ref: 400, user_intent: 2000 } as const;

/** The meta a non-governance block can carry. Widening it to `BlockMeta` would put the cast back. */
type NonGovernanceMeta = NonGovernanceBlock['meta'];

export function meta(over: Partial<NonGovernanceMeta> = {}): NonGovernanceMeta {
  return {
    origin: 'tool',
    sha256: sha256(over.subject?.ref ?? `seed-${over.tier ?? 'episodic'}`),
    tier: 'episodic',
    bytes: 100,
    cacheable: false,
    ...over,
  };
}

export function block(over: Partial<NonGovernanceBlock> = {}): NonGovernanceBlock {
  const text = over.text ?? 'hello';
  return {
    type: 'text',
    text,
    meta: meta({ bytes: text.length }),
    ...over,
  };
}

/**
 * A block with no subject: something a user or the system said. Default tier is
 * `episodic` because that is the honest default for an utterance -- whether it
 * is the leading *intent* is the triage stage's judgement, not the fixture's.
 */
export function unsubjected(
  text: string,
  origin: NonGovernanceMeta['origin'] = 'user',
  tier: NonGovernanceTier = 'episodic',
): NonGovernanceBlock {
  return block({ text, meta: meta({ origin, tier, bytes: text.length }) });
}

export function message(
  role: Role,
  content: readonly NonGovernanceBlock[],
  ts = 1_700_000_000_000,
): NonGovernanceMessage {
  return { role, content, ts };
}

/**
 * A full-width `Message`, for a `ContextState` fixture that carries governance.
 *
 * Deliberately named apart from `message` so that every call site says which
 * boundary it is crossing: this one builds state, `message` builds something a
 * lossy stage can be handed.
 */
export function stateMessage(role: Role, content: readonly ContentBlock[], ts = 1_700_000_000_000): Message {
  return { role, content, ts };
}

export function governanceBlock(text: string): ContentBlock {
  return {
    type: 'text',
    text,
    meta: {
      origin: 'system',
      sha256: sha256(text),
      tier: 'governance',
      bytes: text.length,
      // Cacheable: the same reasoning as `enforcePins` in core-types -- a
      // constraint that re-invalidates the prefix every turn is a tax paid on
      // every request.
      cacheable: true,
    },
  };
}

/** A held governance block, as `partitionForLossy` would have produced it. */
export function heldGovernance(text: string): HeldBlock {
  return { block: governanceBlock(text), reason: 'governance' };
}

/**
 * A governance block presented as a `NonGovernanceBlock`.
 *
 * The one place in this file where the type system is deliberately crossed, and
 * it exists solely to exercise the *runtime* half of the guarantee:
 * `partitionForLossy` removes governance statically, so the only way one can
 * reach a lossy stage is a value that arrived by cast rather than by
 * constructor. Triage diverts such a block into `held`; `assertNoGovernance`
 * throws on it.
 *
 * The `@ts-expect-error` is load-bearing in both directions. It documents that
 * the value is not representable, and if `NonGovernanceTier` is ever widened to
 * include 'governance' it goes unused and the package stops compiling -- which
 * is the tripwire `guards.test.ts` relies on too.
 */
export function smuggledGovernance(text: string): NonGovernanceBlock {
  const wide: ContentBlock = governanceBlock(text);
  // @ts-expect-error -- the whole point of this fixture: governance is not
  // representable as a NonGovernanceBlock, and this stands in for a value that
  // came from outside the type system.
  return wide;
}

/** A deterministic multi-line body of `n` lines. Never spread this: it is one string. */
export function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n');
}

/** The same body, as an array, for callers that want to splice lines together. */
export function lineArray(n: number, prefix = 'line'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i}`);
}

export function toolResult(over: {
  readonly text: string;
  readonly kind?: NonNullable<BlockMeta['subject']>['kind'];
  readonly ref: string;
  readonly version?: string;
  readonly tier?: NonGovernanceTier;
  readonly severity?: BlockMeta['severity'];
  readonly cacheable?: boolean;
  readonly id?: string;
}): NonGovernanceBlock {
  const subject: NonNullable<BlockMeta['subject']> = {
    kind: over.kind ?? 'command',
    ref: over.ref,
    ...(over.version === undefined ? {} : { version: over.version }),
  };
  return block({
    type: 'tool_result',
    text: over.text,
    id: over.id ?? `call-${over.ref}`,
    toolName: over.kind === 'file' ? 'Read' : 'Bash',
    meta: meta({
      subject,
      tier: over.tier ?? 'tool_state',
      bytes: over.text.length,
      sha256: sha256(`${over.ref}@${over.version ?? 'v0'}#${over.text.length}`),
      ...(over.severity === undefined ? {} : { severity: over.severity }),
      ...(over.cacheable === undefined ? {} : { cacheable: over.cacheable }),
    }),
  });
}

export function state(over: Partial<ContextState> = {}): ContextState {
  return {
    messages: [
      stateMessage('system', [block({ text: 'CLAUDE.md' })]),
      stateMessage('user', [block({ text: 'do the thing' })]),
    ],
    pinned: [],
    tokenEstimate: 0,
    policyHash: sha256(''),
    runId: runId('run-1'),
    turn: 1,
    gists: [],
    artifacts: [],
    ...over,
  };
}

export function policy(over: {
  readonly constraints?: readonly string[];
  readonly tierByteCaps?: Record<string, number>;
  readonly trigger?: Record<string, unknown>;
  readonly compaction?: StrataPolicy['pipeline']['compaction'];
  readonly stages?: StrataPolicy['pipeline']['stages'];
} = {}): StrataPolicy {
  return StrataPolicySchema.parse({
    version: 1,
    ...(over.constraints === undefined
      ? {}
      : {
          constraints: over.constraints.map((text, i) => ({
            id: `c${i + 1}`,
            text,
            sha256: sha256(text),
            source: 'org_policy',
            kind: 'soft_policy',
            enforcement: 'block',
          })),
        }),
    pipeline: {
      tierByteCaps: { ...TIER_CAPS, ...over.tierByteCaps },
      compaction: over.compaction ?? 'auto',
      ...(over.stages === undefined ? {} : { stages: over.stages }),
      ...(over.trigger === undefined ? {} : { trigger: over.trigger }),
    },
  });
}

export const CONSTRAINTS = ['never force push to main', 'no secrets in commits'] as const;

/**
 * A transcript with every Tier 0 hazard in it at once: pinned policy at the
 * head, a cacheable system prompt, the leading intent, a cacheable command
 * result, an oversized failing build log, an oversized file read, a re-read of
 * that file, an exact duplicate, a block the producer already superseded, a
 * high-severity block that is far over the cap, a sub-cap file read, an empty
 * tool result, a large block with no subject, and an existing artifact pointer.
 */
export function realisticState(over: Partial<ContextState> = {}): ContextState {
  const buildLog = [
    '> tsc --build',
    'src/a.ts(1,1): error TS2304: Cannot find name foo',
    ...lineArray(200, 'src/a.ts ok'),
    'src/b.ts(9,3): error TS2345: Argument of type string is not assignable',
    'Found 2 errors in 2 files.',
    'npm ERR! code ELIFECYCLE',
    ...lineArray(40, 'trailing noise'),
  ].join('\n');

  const fileBody = lines(400, 'export const value =');
  const secondRead = lines(400, 'export const value = ');

  return state({
    taskId: taskId('task-42'),
    turn: 7,
    messages: [
      stateMessage('system', [
        governanceBlock(CONSTRAINTS[0]),
        block({
          text: 'project instructions: run the tests before claiming success',
          meta: meta({
            origin: 'system',
            tier: 'user_intent',
            bytes: 64,
            cacheable: true,
            sha256: sha256('system-prompt'),
          }),
        }),
      ]),
      stateMessage('user', [
        block({
          text: 'refactor the token estimator so it never throws on an empty context',
          meta: meta({ origin: 'user', tier: 'episodic', bytes: 70, cacheable: true, sha256: sha256('intent') }),
        }),
      ]),
      stateMessage('assistant', [
        block({
          type: 'tool_use',
          text: 'tsc --build',
          id: 'call-build',
          toolName: 'Bash',
          meta: meta({
            origin: 'assistant',
            tier: 'tool_state',
            bytes: 12,
            cacheable: true,
            sha256: sha256('tool_use-build'),
          }),
        }),
      ]),
      stateMessage('user', [
        toolResult({
          ref: 'tsc --build',
          text: buildLog,
          cacheable: true,
          id: 'call-build',
        }),
      ]),
      stateMessage('user', [toolResult({ ref: 'src/estimator.ts', kind: 'file', version: 'v1', text: fileBody })]),
      stateMessage('user', [toolResult({ ref: 'src/estimator.ts', kind: 'file', version: 'v2', text: secondRead })]),
      stateMessage('user', [toolResult({ ref: 'src/estimator.ts', kind: 'file', version: 'v2', text: secondRead })]),
      stateMessage('user', [
        toolResult({
          ref: 'src/legacy.ts',
          kind: 'file',
          version: 'v1',
          text: lines(300, 'legacy'),
          severity: 'error',
        }),
      ]),
      stateMessage('user', [
        toolResult({
          ref: 'src/notes.md',
          kind: 'file',
          version: 'v1',
          text: 'small file, under the cap',
        }),
      ]),
      stateMessage('user', [
        toolResult({
          ref: 'grep estimator',
          kind: 'search',
          version: 'v1',
          text: lines(300, 'match'),
          severity: 'fatal',
        }),
        toolResult({ ref: 'true', text: '' }),
        block({
          text: lines(300, 'no subject, must never be truncated'),
          meta: meta({ origin: 'user', tier: 'episodic', bytes: 7000, cacheable: true, sha256: sha256('unsubjected') }),
        }),
        toolResult({
          ref: 'artifact-probe',
          kind: 'file',
          version: 'v1',
          text: '[strata:pointer]\npath: x\nuri: artifact://file/abc\nsha256: abc\nchars: 10\nlines: 1',
          tier: 'artifact_ref',
        }),
      ]),
      stateMessage('user', [
        toolResult({
          ref: 'an old read',
          version: 'v1',
          text: lines(50, 'stale'),
        }),
        toolResult({
          ref: 'src/flagged.ts',
          kind: 'file',
          version: 'v1',
          text: lines(50, 'flagged'),
        }),
        block({
          type: 'tool_result',
          text: lines(50, 'superseded by the producer'),
          meta: meta({
            origin: 'tool',
            tier: 'tool_state',
            bytes: 1200,
            subject: { kind: 'file', ref: 'src/flagged.ts', version: 'v1' },
            supersededBy: 'v2',
            sha256: sha256('flagged-block'),
          }),
        }),
      ]),
      stateMessage('assistant', [
        block({
          text: 'the estimator is refactored; tests are green',
          meta: meta({ origin: 'assistant', tier: 'episodic', bytes: 45, sha256: sha256('assistant-reply') }),
        }),
      ]),
    ],
    ...over,
  });
}

/** The same transcript, with the policy buffer already materialised as blocks. */
export const PINNED_POLICY = policy({ constraints: CONSTRAINTS });
