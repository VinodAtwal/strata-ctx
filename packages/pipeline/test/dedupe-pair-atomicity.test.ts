/**
 * The pairing invariant as a property, over generated transcripts.
 *
 * ## The invariant, stated precisely
 *
 * Let `before` be the flattened input and `after` the flattened output of
 * `dedupeMessages`. Two blocks *pair* when both carry the same non-empty
 * `ContentBlock.id` and their `type`s are `tool_use` and `tool_result`
 * (`ContentBlock.id` is the correlation id, core-types/src/context.ts:61-62;
 * an absent or empty id is not a correlation at all, dedupe.ts pairIndex). Then:
 *
 *   For every id `v` that has at least one `tool_use` and at least one
 *   `tool_result` in `before`:
 *
 *     (at least one `tool_use` with id `v` survives in `after`)
 *  == (at least one `tool_result` with id `v` survives in `after`)
 *
 * The statement is per *id* rather than per *(use, result)* pair because that is
 * the shape a provider enforces and the shape that is well defined when two
 * calls share one id. When the input has exactly one use and one result for `v`
 * -- the Anthropic and openai-compat case, where the id is unique per call --
 * it collapses to the plain sentence: both halves are in the output, or neither
 * is.
 *
 * Both directions matter. A `tool_use` with no `tool_result` and a `tool_result`
 * naming an absent `tool_use` are both rejected (dedupe.ts, the pairing
 * invariant note), and the original defect only ever produced the second kind.
 *
 * ## Why this is a property and not a list
 *
 * D-11 was fixed with four hand-picked cases
 * (`packages/gateway/test/tool-pairing.test.ts`), all of them chosen by the
 * person who had just seen the bug. A fix verified only against the examples
 * that motivated it is a fix with an unmeasured surface: the pairing pass has
 * three documented exits and the four cases exercise two of them. So: generate
 * the space, assert the property over it, and -- the part that makes the rest of
 * this file worth reading -- check that the generator is sensitive enough to
 * *see* the defects, by running it against local copies of the algorithm with
 * each documented decision broken. Eight of those mutants are the real defects
 * this stage has shipped: four from D-11 (`0ff31b2`) and four from the severity
 * fix (`91ec784`). The corpus is required to catch all eight.
 *
 * ## What is deliberately outside the invariant
 *
 * - An id that is absent or empty. `pairIndex` states that such a block cannot
 *   pair, so there is no pair to break; `an empty id is not a correlation` below
 *   pins that boundary rather than leaving it implicit. Anthropic ids are never
 *   empty in practice, but the Anthropic adapter copies whatever `id` the wire
 *   carried (anthropic-adapter.ts), so the shape is reachable.
 * - A half that has no counterpart **in the input**. A pending call at the tail
 *   of a turn is a real Anthropic shape -- the client sent a `tool_use` and the
 *   result arrives in the next request -- and dedupe cannot invent the missing
 *   half. `every surviving tool_use keeps a result` below therefore states the
 *   invariant over the ids that were complete in the input, which is the only
 *   form of it dedupe can be responsible for, and
 *   `a pending call at the tail of a turn is left alone` states the negative.
 * - Blocks with no `meta.subject`. They are never dropped at all (`decide`),
 *   so they cannot break a pair.
 *
 * ## The provider shapes are the ones that exist
 *
 * Canonical blocks are built with each adapter's own identity formula, cited on
 * each builder, because the identity formula *is* the defect: `ref: block.name`
 * in all three adapters is what made two `Read` calls one identity. Hand-rolled
 * shapes would test a fourth, invented adapter.
 *
 * One consequence of following the adapters rather than a plausible fiction is
 * recorded in the Gemini column's non-vacuity assertion below: a Gemini
 * transcript cannot produce a deduped *tool* block at all, and the reason is a
 * property of the format, not a gap in the corpus.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BlockSubject, NonGovernanceBlock, NonGovernanceMessage, Severity } from '@strata-ctx/core-types';
import { isHighSeverity, sha256 } from '@strata-ctx/core-types';

import { dedupeMessages, mergeAdjacentSameRole, type DedupeReport } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                     */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32. A property run that fails has to be replayable from the seed in the
 * failure message (AGENTS.md 4, determinism), which `Math.random` cannot offer,
 * and a generator package is a dependency this task may not add (AGENTS.md 6.3).
 *
 * Every assertion in this file prints `seed ${item.seed}`, and
 * `generate(seedAt(index), column)` rebuilds the transcript from it. That is the
 * replay path; it is what makes a failure here a regression test rather than an
 anecdote.
 */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Seed for case `i`. The stride is prime so that neighbouring cases are not
 * neighbouring states of one generator stream.
 */
const seedAt = (i: number): number => (0x9e3779b1 + Math.imul(i, 7919)) >>> 0;

const int = (rng: () => number, bound: number): number => Math.floor(rng() * bound);

const chance = (rng: () => number, p: number): boolean => rng() < p;

const pick = <T>(rng: () => number, pool: readonly T[]): T => {
  const value = pool[int(rng, pool.length)];
  if (value === undefined) throw new Error('pick from an empty pool');
  return value;
};

/* -------------------------------------------------------------------------- */
/* Provider shapes                                                              */
/* -------------------------------------------------------------------------- */

type Provider = 'anthropic' | 'gemini' | 'openai-compat';

const PROVIDERS: readonly Provider[] = ['anthropic', 'gemini', 'openai-compat'];

const TOOL_TIER = 'tool_state';

interface CallSpec {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /** The wire correlation token, per provider. */
  readonly id: string;
  /**
   * No adapter sets `subject.version` (the field is canonical, see
   * docs/architecture.md:109), so the version axis is exercised on the canonical
   * model directly. It is what distinguishes "read again, same bytes" from "the
   * file changed under us" (dedupe.ts, `versionKey`).
   */
  readonly version?: string;
  readonly flagged?: boolean;
  /** A `warn`/`error` on a call is a B-4 classifier's label, not a wire field. */
  readonly severity?: Severity;
  /** openai-compat only: `arguments` that is not JSON. */
  readonly malformed?: boolean;
}

interface ResultSpec {
  readonly id: string;
  /** Gemini carries the function name on the response half; the others do not. */
  readonly name?: string;
  readonly version?: string;
  /** anthropic `is_error`, gemini a `response` struct with an `error` key. */
  readonly failed?: boolean;
  /** Gemini's rule for a response with no earlier call of that name. */
  readonly orphan?: boolean;
  readonly flagged?: boolean;
  readonly severity?: Severity;
}

const subject = (kind: BlockSubject['kind'], ref: string, version: string | undefined): BlockSubject => ({
  kind,
  ref,
  ...(version === undefined ? {} : { version }),
});

/** `encodeStruct` (gemini-adapter.ts): a Struct as JSON, anything else as `{}`. */
const encodeStruct = (v: unknown): string =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? JSON.stringify(v) : '{}';

/** `meta.origin` for each half, per adapter. Gemini cannot read the role. */
const callOrigin = (_provider: Provider): NonGovernanceBlock['meta']['origin'] => 'assistant';
const resultOrigin = (provider: Provider): NonGovernanceBlock['meta']['origin'] =>
  provider === 'anthropic' ? 'user' : 'tool';

/**
 * A `tool_use` block as the three adapters that exist produce one.
 *
 * The identity formula is the part under test, so each provider's is spelled out
 * on its own branch. The D-11 defect was one formula, `ref: block.name`, in all
 * three (`toolUseSubject` in each adapter).
 */
const callBlock = (provider: Provider, spec: CallSpec): NonGovernanceBlock => {
  const origin = callOrigin(provider);
  switch (provider) {
    case 'anthropic': {
      // `toolUseSubject` = `name` + JSON of `input`; text is `{tool, input}`;
      // hash is over the whole wire block; `is_error`-free calls carry no severity.
      const wire = { type: 'tool_use', id: spec.id, name: spec.name, input: spec.input };
      const payload = JSON.stringify(wire);
      return {
        type: 'tool_use',
        text: JSON.stringify({ tool: spec.name, input: spec.input }),
        id: spec.id,
        toolName: spec.name,
        cacheControl: null,
        meta: {
          origin,
          sha256: sha256(payload),
          subject: subject('other', `${spec.name}\u0000${JSON.stringify(spec.input)}`, spec.version),
          tier: TOOL_TIER,
          bytes: payload.length,
          cacheable: false,
          ...(spec.severity === undefined ? {} : { severity: spec.severity }),
          ...(spec.flagged === true ? { supersededBy: 'flagged-by-producer' } : {}),
        },
      };
    }
    case 'gemini': {
      // `toolUseSubject` = `name` + `encodeStruct(args)`; `id` falls back to the
      // name because `GeminiFunctionCall.id` is present only on some SDKs.
      const payload = encodeStruct(spec.input);
      return {
        type: 'tool_use',
        text: payload,
        id: spec.id,
        toolName: spec.name,
        cacheControl: null,
        meta: {
          origin,
          sha256: sha256(payload),
          subject: subject('other', `${spec.name}\u0000${payload}`, spec.version),
          tier: TOOL_TIER,
          bytes: payload.length,
          cacheable: false,
          ...(spec.severity === undefined ? {} : { severity: spec.severity }),
          ...(spec.flagged === true ? { supersededBy: 'flagged-by-producer' } : {}),
        },
      };
    }
    case 'openai-compat': {
      // `toolUseSubject` = `name` + `arguments` **verbatim**, because a
      // re-serialisation would be a cache miss; a `not json` `arguments` is the
      // malformed-arguments label the adapter copies through.
      const args = spec.malformed === true ? 'not json' : JSON.stringify(spec.input);
      return {
        type: 'tool_use',
        text: args,
        id: spec.id,
        toolName: spec.name,
        meta: {
          origin,
          sha256: sha256(JSON.stringify(['tool_use', args, spec.id, spec.name])),
          subject: subject('other', `${spec.name}\u0000${args}`, spec.version),
          tier: TOOL_TIER,
          bytes: args.length,
          cacheable: false,
          ...(spec.severity === undefined ? {} : { severity: spec.severity }),
          ...(spec.flagged === true ? { supersededBy: 'flagged-by-producer' } : {}),
        },
      };
    }
  }
};

/** A `tool_use` whose name was missing on the wire: no id, no toolName, no subject. */
const namelessCallBlock = (origin: NonGovernanceBlock['meta']['origin']): NonGovernanceBlock => ({
  type: 'tool_use',
  text: '{}',
  cacheControl: null,
  meta: { origin, sha256: sha256('{}'), tier: TOOL_TIER, bytes: 2, cacheable: false },
});

/**
 * A `tool_result` block as the three adapters produce one. The result's identity
 * is the correlation token in all three, and deliberately not the call's identity
 * (`toolResultSubject` in each adapter): a result that shared its call's subject
 * would read as a newer version of the call, which is the Gemini half of D-11.
 */
const resultBlock = (provider: Provider, spec: ResultSpec): NonGovernanceBlock => {
  const origin = resultOrigin(provider);
  switch (provider) {
    case 'anthropic': {
      // `toolResultSubject` = `tool_use_id`; text is the string content; and
      // `metaFor` turns `is_error: true` into `severity: 'error'`. That last one
      // is load-bearing and is the whole subject of the ENOENT invariant: without
      // it the fixture is a shape no adapter emits, and the ENOENT it claims to
      // test is deduped away correctly, which is what makes this a fixture bug
      // rather than a product bug when it goes missing.
      const wire = {
        type: 'tool_result',
        tool_use_id: spec.id,
        content: spec.failed === true ? 'ENOENT: no such file' : `contents of ${spec.id}`,
        ...(spec.failed === true ? { is_error: true } : {}),
      };
      const payload = JSON.stringify(wire);
      const severity: Severity | undefined = spec.severity ?? (spec.failed === true ? 'error' : undefined);
      return {
        type: 'tool_result',
        text: wire.content,
        id: spec.id,
        cacheControl: null,
        meta: {
          origin,
          sha256: sha256(payload),
          subject: subject('other', spec.id, spec.version),
          tier: TOOL_TIER,
          bytes: payload.length,
          cacheable: false,
          ...(severity === undefined ? {} : { severity }),
          ...(spec.flagged === true ? { supersededBy: 'flagged-by-producer' } : {}),
        },
      };
    }
    case 'gemini': {
      // `toolResultSubject` = `name`; `id` is filled with the name because
      // `GeminiFunctionResponse` has no id field at all; an `error` key in the
      // Struct is Gemini's only failure signal, and a response naming a function
      // no earlier part called is `warn`.
      const response: Record<string, unknown> =
        spec.failed === true ? { error: 'ENOENT: no such file' } : { output: `contents of ${spec.id}` };
      const payload = encodeStruct(response);
      const name = spec.name ?? spec.id;
      const severity: Severity | undefined =
        spec.severity ?? (spec.failed === true ? 'error' : spec.orphan === true ? 'warn' : undefined);
      return {
        type: 'tool_result',
        text: payload,
        id: name,
        toolName: name,
        cacheControl: null,
        meta: {
          origin,
          sha256: sha256(payload),
          subject: subject('other', name, spec.version),
          tier: TOOL_TIER,
          bytes: payload.length,
          cacheable: false,
          ...(severity === undefined ? {} : { severity }),
          ...(spec.flagged === true ? { supersededBy: 'flagged-by-producer' } : {}),
        },
      };
    }
    case 'openai-compat': {
      // `toolResultSubject` = `tool_call_id`. The format has no `is_error`, so a
      // failure is a convention and the block carries no severity unless a
      // classifier wrote one.
      const text = spec.failed === true ? 'ENOENT: no such file' : `contents of ${spec.id}`;
      return {
        type: 'tool_result',
        text,
        id: spec.id,
        meta: {
          origin,
          sha256: sha256(JSON.stringify(['tool_result', text, spec.id, null])),
          subject: subject('other', spec.id, spec.version),
          tier: TOOL_TIER,
          bytes: text.length,
          cacheable: false,
          ...(spec.severity === undefined ? {} : { severity: spec.severity }),
          ...(spec.flagged === true ? { supersededBy: 'flagged-by-producer' } : {}),
        },
      };
    }
  }
};

/** A user/system utterance: prose carries no subject (`decide`). */
const textBlock = (
  origin: NonGovernanceBlock['meta']['origin'],
  text: string,
  cacheable = false,
): NonGovernanceBlock => ({
  type: 'text',
  text,
  meta: { origin, sha256: sha256(text), tier: 'episodic', bytes: text.length, cacheable },
});

/**
 * A Gemini `fileData` part: the only non-tool block in any of the three adapters
 * that carries a subject (`toolSubject(uri)` -- the `fileUri`, not a `file:`
 * prefix). Gemini-only, because it is the only adapter that emits it.
 *
 * It is also the *only* shape in which a Gemini transcript can drop anything at
 * all, and the corpus needs it: see the non-vacuity assertion for the column.
 */
const fileBlock = (uri: string): NonGovernanceBlock => ({
  type: 'image',
  text: 'text/plain',
  id: uri,
  meta: {
    origin: 'assistant',
    sha256: sha256('text/plain'),
    subject: subject('other', uri, undefined),
    tier: 'episodic',
    bytes: 'text/plain'.length,
    cacheable: false,
  },
});

const msg = (role: NonGovernanceMessage['role'], content: readonly NonGovernanceBlock[]): NonGovernanceMessage => ({
  role,
  content,
  ts: 1_700_000_000_000,
});

/** The role the canonical model files a call under, per adapter. */
const callRole = (_provider: Provider): NonGovernanceMessage['role'] => 'assistant';

/** The role the canonical model files a result under, per adapter. */
const resultRole = (provider: Provider): NonGovernanceMessage['role'] =>
  provider === 'anthropic' ? 'user' : 'tool';

/* -------------------------------------------------------------------------- */
/* The generator                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Pools small on purpose. The defect needed two calls with the same name and
 * different arguments *in one turn*, so a pool of five names and three paths
 * makes that the common case rather than a rarity -- a generator that mostly
 * produces distinct identities would pass against a broken implementation.
 */
const NAMES: readonly string[] = ['Read', 'Read', 'Read', 'Grep', 'Bash'];
const PATHS: readonly string[] = ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'];
const COMMANDS: readonly string[] = ['ls -la', 'git status'];
/**
 * Two, so the same `fileUri` is re-sent across turns and dedupes. A pool of two
 * is what makes this shape worth generating at all: with a large pool every
 * snapshot would be a distinct identity and the `fileData` drop path would never
 * run. Two snapshots of one file is what a Gemini agent actually re-sends.
 */
const FILE_URIS: readonly string[] = ['file:///repo/snap-0.txt', 'file:///repo/snap-1.txt'];

const inputFor = (name: string, rng: () => number): Record<string, unknown> =>
  name === 'Bash'
    ? { command: pick(rng, COMMANDS) }
    : name === 'Grep'
      ? { pattern: pick(rng, ['TODO', 'FIXME']) }
      : { file_path: pick(rng, PATHS) };

interface Generated {
  readonly index: number;
  readonly seed: number;
  readonly provider: Provider;
  readonly messages: readonly NonGovernanceMessage[];
}

/**
 * One transcript: 1-3 turns, each with 1-3 calls and an independently drawn set of
 * faults. Every knob below exists because a branch of the pairing pass or of the
 * identity formula turns on it.
 */
const generate = (index: number, seed: number, provider: Provider): Generated => {
  const rng = prng(seed);
  const messages: NonGovernanceMessage[] = [];
  /**
   * No adapter emits a message with no blocks, so the generator must not either:
   * an empty message is garbage in, and asserting the pipeline never produces one
   * is a claim about a shape no client sends. The structural check still holds the
   * line, because dedupe can *empty* a message by deleting its only block.
   */
  const push = (role: NonGovernanceMessage['role'], content: readonly NonGovernanceBlock[]): void => {
    if (content.length > 0) messages.push(msg(role, content));
  };
  const turnCount = 1 + int(rng, 3);
  let seq = 0;

  for (let turn = 0; turn < turnCount; turn += 1) {
    if (chance(rng, 0.85)) push('user', [textBlock('user', `turn ${turn}`)]);

    const calls: CallSpec[] = [];
    const callCount = 1 + int(rng, 3);
    for (let i = 0; i < callCount; i += 1) {
      // A true duplicate: same name and same arguments as an earlier call in this
      // turn. This is the case the gateway file had to add by hand.
      const source = calls.length > 0 && chance(rng, 0.45) ? pick(rng, calls) : undefined;
      const name = source?.name ?? pick(rng, NAMES);
      // Only where a client can put one. Gemini's canonical id *is* the function
      // name, so borrowing another call's id there would produce a call whose
      // `toolName` and `id` disagree -- a shape no Gemini adapter emits, and one
      // whose result then correlates against two unrelated calls.
      const duplicateId =
        provider !== 'gemini' && calls.length > 0 && chance(rng, 0.12) ? pick(rng, calls).id : undefined;
      seq += 1;
      calls.push({
        name,
        input: source?.input ?? inputFor(name, rng),
        id:
          duplicateId ??
          (provider === 'gemini'
            ? name
            : provider === 'anthropic'
              ? `toolu_${String(seq).padStart(2, '0')}`
              : `call_${String(seq).padStart(2, '0')}`),
        ...(chance(rng, 0.45) ? { version: `v${1 + int(rng, 2)}` } : {}),
        ...(chance(rng, 0.06) ? { flagged: true } : {}),
        // A call half the adapters never label themselves; a B-4 classifier can,
        // and that is one of the only ways a call carries severity.
        ...(chance(rng, 0.1) ? { severity: 'error' as Severity } : {}),
        ...(provider === 'openai-compat' && chance(rng, 0.15) ? { malformed: true } : {}),
      });
    }

    // Gemini fills the canonical id with the function name, so two calls to the
    // same function anywhere in the transcript share an id by construction. That
    // is the ambiguous case of the pairing pass, not a fault this file has to
    // inject for Gemini -- but Anthropic and openai-compat can be sent a
    // duplicated id by a client, so the generator injects one for them above.
    const results: ResultSpec[] = calls
      .filter(() => chance(rng, 0.85))
      .map((call) => ({
        id: call.id,
        ...(provider === 'gemini' ? { name: call.name } : {}),
        ...(chance(rng, 0.45) ? { version: `v${1 + int(rng, 2)}` } : {}),
        ...(chance(rng, 0.22) ? { failed: true } : {}),
        ...(chance(rng, 0.06) ? { flagged: true } : {}),
        // A producer flag on a result is the shape `91ec784` fix 4 is about: the
        // flag says a later read supersedes, and severity says the record of a
        // failure does not expire.
        ...(chance(rng, 0.08) ? { severity: 'fatal' as Severity } : {}),
      }));

    // An injected or truncated result: no call anywhere in the transcript answers
    // it. Gemini labels it `warn`.
    if (chance(rng, 0.15)) {
      const seen = new Set(calls.map((c) => c.id));
      const orphanId =
        provider === 'gemini'
          ? 'NeverCalled'
          : provider === 'anthropic'
            ? `toolu_9${turn}`
            : `call_9${turn}`;
      if (!seen.has(orphanId)) {
        results.push({
          id: orphanId,
          ...(provider === 'gemini' ? { name: orphanId, orphan: true } : {}),
        });
      }
    }

    const callBlocks = calls.map((call) => callBlock(provider, call));
    const resultBlocks = results.map((result) => resultBlock(provider, result));

    // Interleaving that a real client produces: some calls answered before the
    // rest are made. This is what puts a `tool_result` before its own `tool_use`
    // in transcript order, so the pairing pass is exercised in both directions.
    const split = calls.length > 1 && chance(rng, 0.35);
    if (split) {
      const at = 1 + int(rng, calls.length - 1);
      push(callRole(provider), callBlocks.slice(0, at));
      push(
        resultRole(provider),
        resultBlocks.filter((r) => calls.slice(0, at).some((c) => c.id === r.id)),
      );
      push(callRole(provider), callBlocks.slice(at));
      push(
        resultRole(provider),
        resultBlocks.filter((r) => calls.slice(at).some((c) => c.id === r.id)),
      );
    } else if (resultBlocks.length > 0 && chance(rng, 0.25)) {
      // A garbled input: the answers arrive before the calls that asked for them.
      // Same pairing arithmetic, opposite order, and the position `91ec784` fix 2
      // is about: a severe half that is `block` rather than `partner`.
      push(resultRole(provider), resultBlocks);
      push(callRole(provider), callBlocks);
    } else {
      push(callRole(provider), callBlocks);
      push(resultRole(provider), resultBlocks);
    }

    if (chance(rng, 0.12)) push('user', [textBlock('user', `note after turn ${turn}`)]);
    if (provider === 'gemini' && chance(rng, 0.15)) push('assistant', [namelessCallBlock('assistant')]);
    // One snapshot per turn, not one in some turns: a Gemini agent that read a
    // file once re-sends that snapshot in every later turn, so with a two-URI pool
    // the duplicate `fileData` path runs on nearly every transcript instead of on
    // the minority that happened to draw the same URI twice. This is the only
    // Gemini shape `dedupeMessages` can drop -- see the note above the fixture
    // pool -- so it carries the whole column.
    if (provider === 'gemini') push('assistant', [fileBlock(pick(rng, FILE_URIS))]);
  }

  if (messages.length === 0 || messages[0]?.content.length === 0) {
    messages.unshift(msg('user', [textBlock('user', 'leading intent')]));
  }
  return { index, seed, provider, messages };
};

const SEED_COUNT = 300;

const corpus = (provider: Provider, count = SEED_COUNT): readonly Generated[] =>
  Array.from({ length: count }, (_, i) => generate(i, seedAt(i), provider));

/* -------------------------------------------------------------------------- */
/* The oracles                                                                  */
/* -------------------------------------------------------------------------- */

const flat = (messages: readonly NonGovernanceMessage[]): readonly NonGovernanceBlock[] =>
  messages.flatMap((m) => m.content);

/** A half that can pair at all: an id that is present and non-empty. */
const isHalf = (block: NonGovernanceBlock): block is NonGovernanceBlock & { readonly id: string } =>
  (block.type === 'tool_use' || block.type === 'tool_result') && typeof block.id === 'string' && block.id !== '';

interface Halves {
  readonly uses: number;
  readonly results: number;
}

const halvesById = (blocks: readonly NonGovernanceBlock[]): Map<string, Halves> => {
  const table = new Map<string, Halves>();
  for (const block of blocks) {
    if (!isHalf(block)) continue;
    const at = table.get(block.id) ?? { uses: 0, results: 0 };
    if (block.type === 'tool_use') table.set(block.id, { uses: at.uses + 1, results: at.results });
    else table.set(block.id, { uses: at.uses, results: at.results + 1 });
  }
  return table;
};

/**
 * The pairing invariant. One entry per id that was complete in the input and is
 * not balanced in the output. Empty is the invariant.
 */
const pairViolations = (before: readonly NonGovernanceMessage[], after: readonly NonGovernanceMessage[]): string[] => {
  const input = halvesById(flat(before));
  const output = halvesById(flat(after));
  const violations: string[] = [];
  for (const [id, had] of input) {
    if (had.uses === 0 || had.results === 0) continue;
    const kept = output.get(id) ?? { uses: 0, results: 0 };
    if ((kept.uses > 0) === (kept.results > 0)) continue;
    violations.push(
      `id ${id}: input had ${had.uses} use(s)/${had.results} result(s), output kept ${kept.uses} use(s)/${kept.results} result(s)`,
    );
  }
  return violations;
};

/**
 * Identity, the way `decide` and `coDropOf` both compute it. Two rules in the
 * source agree on this and one place here has to as well: a replacement for a
 * dropped block is a block with the *same identity*, whatever its reason.
 */
const identityOf = (block: NonGovernanceBlock): string | undefined => {
  const s = block.meta.subject;
  return s === undefined ? undefined : `${s.kind}\u0000${s.ref}`;
};

/** `kind\0ref` of every `tool_use` with id `v`, in one message list. */
const callIdentitiesFor = (messages: readonly NonGovernanceMessage[], id: string): Set<string> => {
  const out = new Set<string>();
  for (const b of flat(messages)) {
    if (b.type !== 'tool_use' || b.id !== id) continue;
    const identity = identityOf(b);
    if (identity !== undefined) out.add(identity);
  }
  return out;
};

/**
 * ## The severity invariant, in the form the source actually promises
 *
 * `decide` does not promise that a severe block is never dropped. It promises
 * that it is not dropped *unless an equally severe copy stands in for it*, which
 * is what "the surviving copy carries the same severity" means once it is
 * checked instead of assumed, and what the pairing pass re-applies across the two
 * halves of a tool pair. So the oracle is per block, and -- this is the part that
 * matters -- keyed on the *fact* a block carries rather than on the block:
 *
 * - A severe `tool_use` carries its own fact: the identity. Something severe with
 *   that same identity has to survive.
 * - A severe `tool_result` carries a fact about the *call it answers*, because its
 *   own subject is only the correlation id (`toolResultSubject`). So the
 *   guarantee is: some surviving severe result answers a surviving call of the
 *   same identity. That is precisely the walk `survivingTwin` performs -- the
 *   identity winner's own result -- and it is why the oracle cannot simply compare
 *   subjects: two results of two ids for one path are two copies of one fact, and
 *   keeping one of them is correct behaviour, not a severity loss.
 *
 * The weaker forms fail in both directions. "Some severe block survived somewhere"
 * passes for a transcript that dropped the ENOENT and kept an unrelated `fatal`,
 * which is the failure `91ec784` shipped. Comparing subjects on the result itself
 * is stricter than the source, and rejects a correct transcript: two `Read` calls
 * of one path that both failed keep exactly one ENOENT, which is the whole point.
 *
 * A severe block with no subject is exempt: `decide` returns before it can drop,
 * so there is nothing to guarantee. So is a severe result whose id no call in the
 * input carries -- an injected or truncated result has no fact to lose.
 */
const severityViolations = (
  before: readonly NonGovernanceMessage[],
  after: readonly NonGovernanceMessage[],
): string[] => {
  const surviving = flat(after);
  const survivingSevereCalls = new Set<string>();
  for (const b of surviving) {
    if (b.type !== 'tool_use' || !isHighSeverity(b)) continue;
    const identity = identityOf(b);
    if (identity !== undefined) survivingSevereCalls.add(identity);
  }
  // (identity of the answering call) -> is there a severe result answering a
  // surviving call of that identity?
  const severeResultsFor = new Map<string, boolean>();
  for (const r of surviving) {
    if (r.type !== 'tool_result' || !isHighSeverity(r) || typeof r.id !== 'string' || r.id === '') continue;
    for (const identity of callIdentitiesFor(after, r.id)) severeResultsFor.set(identity, true);
  }

  const violations: string[] = [];
  for (const block of flat(before)) {
    if (!isHighSeverity(block)) continue;
    if (block.type === 'tool_use') {
      const identity = identityOf(block);
      if (identity === undefined) continue;
      if (survivingSevereCalls.has(identity)) continue;
      violations.push(`dropped the high-severity tool_use at ${block.meta.subject?.ref ?? '-'} and no severe call of that identity survived`);
      continue;
    }
    if (block.type !== 'tool_result' || typeof block.id !== 'string' || block.id === '') continue;
    const facts = callIdentitiesFor(before, block.id);
    if (facts.size === 0) continue;
    if ([...facts].some((identity) => severeResultsFor.get(identity) === true)) continue;
    violations.push(
      `dropped the high-severity tool_result at ${block.meta.subject?.ref ?? '-'} and no severe result survived for the call it answered (${[...facts].join(', ')})`,
    );
  }
  return violations;
};

/**
 * A producer flag is honoured unconditionally for a benign block, and never for a
 * severe one: the flag says a later read makes an earlier one less true, and that
 * does not expire the record that the earlier read *failed* (`91ec784`). The
 * oracle is absolute here rather than per identity, because the source draws the
 * line exactly here -- `decide` consults severity before it reads the flag at
 * all.
 */
const flagViolations = (before: readonly NonGovernanceMessage[], report: DedupeReport): string[] => {
  const severeHashes = new Set(flat(before).filter(isHighSeverity).map((b) => b.meta.sha256));
  const violations: string[] = [];
  for (const drop of report.drops) {
    if (drop.reason !== 'superseded_by_flag') continue;
    if (severeHashes.has(drop.sha256)) violations.push(`dropped an error/fatal block under a producer flag (ref ${drop.ref})`);
  }
  return violations;
};

/** The report has to be the truth about what left, and the output has to stay a legal request. */
const structuralViolations = (
  before: readonly NonGovernanceMessage[],
  after: readonly NonGovernanceMessage[],
  report: DedupeReport,
): string[] => {
  const violations: string[] = [];
  const reasons = Object.values(report.byReason).reduce((a, b) => a + b, 0);
  if (report.dropped !== report.drops.length) violations.push(`dropped ${report.dropped} but reported ${report.drops.length}`);
  if (report.dropped !== reasons) violations.push(`dropped ${report.dropped} but byReason sums to ${reasons}`);
  if (report.byReason.retained_severity !== 0) {
    violations.push(`retained_severity counted ${report.byReason.retained_severity} drops, which is structurally always zero`);
  }
  const survivors = flat(after).length;
  if (survivors + report.dropped !== flat(before).length) {
    violations.push(`${flat(before).length} blocks in, ${survivors} + ${report.dropped} accounted for`);
  }
  for (const [i, m] of after.entries()) {
    if (m.content.length === 0) violations.push(`message ${i} is empty`);
    // Merging only runs when something was dropped, so an input that already
    // carries two adjacent same-role messages keeps them. A Gemini transcript
    // does: results ride in a `user` turn and the next `user` text turn follows
    // it. That is an ingress/egress question, not a guarantee this stage makes.
    if (report.dropped === 0) continue;
    const next = after[i + 1];
    if (next !== undefined && next.role === m.role) violations.push(`messages ${i}/${i + 1} are adjacent and both ${m.role}`);
  }
  return violations;
};

const renderBlock = (b: NonGovernanceBlock): string => {
  const s = b.meta.subject;
  const subjectText = s === undefined ? '-' : `${s.kind}:${s.ref}@${s.version ?? '-'}`;
  const flags = [
    b.id === undefined ? '' : `#${b.id}`,
    b.toolName === undefined ? '' : `@${b.toolName}`,
    b.meta.severity === undefined ? '' : `sev=${b.meta.severity}`,
    b.meta.supersededBy === undefined ? '' : `flag=${b.meta.supersededBy}`,
  ].join('');
  return `{${b.type}${flags} subj=${subjectText} ${JSON.stringify(b.text ?? null)}}`;
};

const render = (messages: readonly NonGovernanceMessage[]): string =>
  messages.map((m, i) => `  ${i} ${m.role} ${m.content.map(renderBlock).join(' ')}`).join('\n');

interface Run {
  readonly messages: readonly NonGovernanceMessage[];
  readonly report: DedupeReport;
}

/**
 * The failure message every corpus assertion uses: the seed, the column, the
 * whole input transcript, the whole output transcript, and the report. A
 * generated failure is worthless without all five, and the seed is what makes it
 * replayable (`generate(index, seedAt(index), provider)`).
 */
const context = (item: Generated, run: Run): string =>
  [
    `seed ${item.seed} (index ${item.index}, column ${item.provider})`,
    `replay: generate(${item.index}, ${item.seed}, '${item.provider}')`,
    'input:',
    render(item.messages),
    'output:',
    render(run.messages),
    `report: ${JSON.stringify(run.report)}`,
  ].join('\n');

/* -------------------------------------------------------------------------- */
/* Coverage of the generated space                                             */
/* -------------------------------------------------------------------------- */

const FEATURES = [
  'identicalCalls',
  'sameNameDifferentArgs',
  'distinctNames',
  'duplicateId',
  'callWithoutResult',
  'resultWithoutCall',
  'nonTextBlockWithoutSubject',
  'versionedSubject',
  'producerFlag',
  'flagDropFired',
  'severeCallHalf',
  'severeResultHalf',
  'resultBeforeItsCall',
  'multiTurn',
  'pairLeftTogether',
  'severityRefusalFired',
  'ambiguousGroupKept',
  'nonToolDropped',
] as const;

type Feature = (typeof FEATURES)[number];

/**
 * Which shapes this case actually contains. A generator that quietly stops
 * producing a shape would make every property over it weaker with no visible
 * failure, so the corpus asserts its own coverage -- a vacuous property test is
 * worse than none.
 */
const featuresOf = (before: readonly NonGovernanceMessage[], after: readonly NonGovernanceMessage[], report: DedupeReport): Feature[] => {
  const input = flat(before);
  const output = flat(after);
  const uses = input.filter((b) => b.type === 'tool_use');
  const features = new Set<Feature>();

  const byCallIdentity = new Map<string, number>();
  const byName = new Map<string, Set<string>>();
  for (const b of uses) {
    const ref = identityOf(b) ?? '';
    byCallIdentity.set(ref, (byCallIdentity.get(ref) ?? 0) + 1);
    const name = b.toolName ?? '';
    const refs = byName.get(name) ?? new Set<string>();
    refs.add(ref);
    byName.set(name, refs);
  }
  if ([...byCallIdentity.values()].some((n) => n > 1)) features.add('identicalCalls');
  if ([...byName.values()].some((refs) => refs.size > 1)) features.add('sameNameDifferentArgs');
  if (byName.size > 1) features.add('distinctNames');

  const ids = halvesById(input);
  for (const [, h] of ids) {
    if (h.uses > 1 || h.results > 1) features.add('duplicateId');
    if (h.uses > 0 && h.results === 0) features.add('callWithoutResult');
    if (h.results > 0 && h.uses === 0) features.add('resultWithoutCall');
  }

  if (input.some((b) => b.type !== 'text' && b.meta.subject === undefined)) features.add('nonTextBlockWithoutSubject');
  if (input.some((b) => b.meta.subject?.version !== undefined)) features.add('versionedSubject');
  if (input.some((b) => b.meta.supersededBy !== undefined)) features.add('producerFlag');
  if (uses.some(isHighSeverity)) features.add('severeCallHalf');
  if (input.some((b) => b.type === 'tool_result' && isHighSeverity(b))) features.add('severeResultHalf');
  if (before.length > 4) features.add('multiTurn');
  if (report.byReason.superseded_by_flag > 0) features.add('flagDropFired');
  if (input.filter((b) => b.type === 'image').length > output.filter((b) => b.type === 'image').length) {
    features.add('nonToolDropped');
  }

  /**
   * A `tool_result` positioned before the `tool_use` it answers. The index has to
   * be the *first call* carrying the id, not the first block: on a garbled
   * transcript the first block with the id is often the result itself, so a
   * detector that recorded "first index with this id" could never observe the
   * shape it was looking for -- which is exactly what happened.
   */
  const firstCallAt = new Map<string, number>();
  input.forEach((b, i) => {
    if (b.type !== 'tool_use' || typeof b.id !== 'string' || b.id === '') return;
    if (!firstCallAt.has(b.id)) firstCallAt.set(b.id, i);
  });
  input.forEach((b, i) => {
    if (b.type !== 'tool_result' || typeof b.id !== 'string') return;
    const callAt = firstCallAt.get(b.id);
    if (callAt !== undefined && i < callAt) features.add('resultBeforeItsCall');
  });

  const kept = halvesById(output);
  for (const [id, had] of ids) {
    if (had.uses === 0 || had.results === 0) continue;
    const after_ = kept.get(id) ?? { uses: 0, results: 0 };
    if (after_.uses === 0 && after_.results === 0) features.add('pairLeftTogether');
    if ((had.uses > 1 || had.results > 1) && after_.uses > 0 && after_.results > 0) features.add('ambiguousGroupKept');
  }
  if (report.retainedHighSeverity > 0) features.add('severityRefusalFired');
  return [...features];
};

/**
 * What each column has to produce. Gemini's column is not a subset of the others
 * and is not allowed to be: `nonTextBlockWithoutSubject` is Gemini-only (only
 * Gemini emits a name-less `functionCall`), `nonToolDropped` is Gemini-only for
 * the same structural reason, and the result-before-its-call shape is easier to
 * reach where the results ride in their own `tool` message.
 *
 * A column missing an entry it is expected to produce has a generator gap; a
 * column *producing* an entry it was not expected to is not a failure, so this is
 * an "at least these" list and not an exact set.
 */
const EXPECTED_FEATURES: Readonly<Record<Provider, readonly Feature[]>> = {
  anthropic: [
    'identicalCalls',
    'sameNameDifferentArgs',
    'distinctNames',
    'duplicateId',
    'callWithoutResult',
    'resultWithoutCall',
    'versionedSubject',
    'producerFlag',
    'flagDropFired',
    'severeCallHalf',
    'severeResultHalf',
    'resultBeforeItsCall',
    'multiTurn',
    'pairLeftTogether',
    'severityRefusalFired',
    'ambiguousGroupKept',
  ],
  gemini: [
    'identicalCalls',
    'sameNameDifferentArgs',
    'distinctNames',
    'duplicateId',
    'callWithoutResult',
    'resultWithoutCall',
    'nonTextBlockWithoutSubject',
    'versionedSubject',
    'producerFlag',
    'flagDropFired',
    'severeCallHalf',
    'severeResultHalf',
    'resultBeforeItsCall',
    'multiTurn',
    'severityRefusalFired',
    'ambiguousGroupKept',
    'nonToolDropped',
  ],
  'openai-compat': [
    'identicalCalls',
    'sameNameDifferentArgs',
    'distinctNames',
    'duplicateId',
    'callWithoutResult',
    'resultWithoutCall',
    'versionedSubject',
    'producerFlag',
    'flagDropFired',
    'severeCallHalf',
    'severeResultHalf',
    'resultBeforeItsCall',
    'multiTurn',
    'pairLeftTogether',
    'severityRefusalFired',
    'ambiguousGroupKept',
  ],
};

/* -------------------------------------------------------------------------- */
/* The property                                                                 */
/* -------------------------------------------------------------------------- */

describe('B-1 pairing invariant: over generated transcripts', () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: every complete pair is in the output whole or not at all`, () => {
      let dropped = 0;
      let decided = 0;
      let total = 0;
      for (const item of corpus(provider)) {
        const run = dedupeMessages(item.messages);
        total += 1;
        if (run.report.dropped > 0) dropped += 1;
        // A "decision" is a block the stage actually ruled on: it dropped
        // something, or it held something back for severity. A corpus where this
        // is near zero means the identity map never fired and every property over
        // it is measuring nothing.
        if (run.report.dropped > 0 || run.report.retainedHighSeverity > 0) decided += 1;

        const where = context(item, run);
        assert.deepEqual(pairViolations(item.messages, run.messages), [], `pairing broken\n${where}`);
        assert.deepEqual(severityViolations(item.messages, run.messages), [], `severity lost\n${where}`);
        assert.deepEqual(flagViolations(item.messages, run.report), [], `a producer flag beat severity\n${where}`);
        assert.deepEqual(structuralViolations(item.messages, run.messages, run.report), [], `report or shape wrong\n${where}`);
      }

      // See the Gemini note in `dedupedSomething`. Both floors are far below the
      // measured values on purpose: they are tripwires for a generator that has
      // stopped producing the shapes the property is argued from, not a measure
      // of how often dedupe fires.
      assert.ok(
        decided > total * 0.5,
        `${provider}: only ${decided}/${total} cases reached a dedupe decision, so the property is over nothing`,
      );
      assert.ok(
        dropped > 0,
        `${provider}: nothing was dropped in ${total} cases, so no drop path ran`,
      );
    });
  }

  /**
   * Non-vacuity, stated per column, with the reason each number is where it is.
   *
   * The tempting metric -- "most cases dropped something" -- is the wrong one for
   * Gemini, and getting that wrong is what made an earlier version of this file
   * assert `droppedSomething > SEED_COUNT / 2` against a column that is mostly
   * built to refuse. The Gemini column is refusal-shaped for a structural reason:
   *
   * - A `tool_use` is identified by `name` + args and its `tool_result` by `name`
   *   alone (`toolUseSubject` / `toolResultSubject`), so a call and its own answer
   *   never share an identity and a result cannot supersede the call that answers
   *   it on identity grounds.
   * - Two results *do* share an identity only when two calls share a function
   *   name -- and then two calls share a canonical id too, because Gemini's id
   *   *is* the name. `counterparts.length > 1 || ownCount > 1` fires and the
   *   pairing pass retracts. 255/300 Gemini transcripts hit that exit.
   *
   * So Gemini drops where the two are *not* competing: `fileData`, the one
   * non-tool block with a subject, which the generator re-sends once per turn from
   * a two-URI pool (168/300 cases), and the rare tool drop where a producer flag
   * removed a result on non-identity grounds and the pairing pass then co-dropped
   * the single call that answered it (15/300). Both are asserted below; the
   * `fileData` count is what carries the column past its floor, and it is the
   * honest one to quote, because a Gemini tool drop that was *not* also a
   * `fileData` drop would mean the pairing pass deleted half a pair.
   */
  const dedupedSomething = (provider: Provider): { dropped: number; refused: number; total: number } => {
    let dropped = 0;
    let refused = 0;
    let total = 0;
    for (const item of corpus(provider)) {
      const { report } = dedupeMessages(item.messages);
      total += 1;
      if (report.dropped > 0) dropped += 1;
      const features = featuresOf(item.messages, dedupeMessages(item.messages).messages, report);
      if (features.includes('ambiguousGroupKept') || report.retainedHighSeverity > 0) refused += 1;
    }
    return { dropped, refused, total };
  };

  it('every column reaches the drop and the refusal paths, and says how often', () => {
    for (const provider of PROVIDERS) {
      const { dropped, refused, total } = dedupedSomething(provider);
      const why = `${provider}: ${JSON.stringify({ dropped, refused, total })}`;
      // Refusal: the stage was consulted and declined to delete something it had
      // otherwise dropped. The floor differs by column for a structural reason,
      // not a tuned one:
      //
      // - Gemini is structurally ambiguous. Its canonical id *is* the function
      //   name, so two calls to one function in a transcript are ambiguous by
      //   construction and the generator never has to inject that.
      // - Anthropic ids are unique unless the generator injects a client-side
      //   duplicate, which it does at 12% per call.
      // - openai-compat ids are unique and the injection rate is the same, so
      //   this column has the fewest ambiguous groups by construction: the
      //   severity refusals carry most of the number. A floor of a half would be
      //   asserting something about the generator rather than about the code, so
      //   it is set where this column's own rates put it.
      const refusalFloor = provider === 'openai-compat' ? 0.3 : 0.5;
      assert.ok(
        refused / total > refusalFloor,
        `${why} -- the pairing pass was consulted and ruled in only ${refused}/${total} cases`,
      );
      // Drops: Gemini's column is mostly built to refuse (see the header of this
      // block), so its floor is lower; the other two drop tool identities freely.
      const dropFloor = provider === 'gemini' ? 0.4 : 0.5;
      assert.ok(
        dropped / total > dropFloor,
        `${why} -- only ${dropped}/${total} cases dropped anything; see the Gemini note above for why this floor is lower there`,
      );
    }
  });

  it('the corpus still covers every shape the invariant is argued from', () => {
    for (const provider of PROVIDERS) {
      const seen = new Set<Feature>();
      for (const item of corpus(provider)) {
        const run = dedupeMessages(item.messages);
        for (const f of featuresOf(item.messages, run.messages, run.report)) seen.add(f);
      }
      const missing = EXPECTED_FEATURES[provider].filter((f) => !seen.has(f));
      assert.deepEqual(missing, [], `${provider}: the generator stopped producing: ${missing.join(', ')}`);
    }
    // And nothing named in FEATURES has drifted out of the expectation table, or
    // a new detector would be silently optional.
    const listed = new Set(PROVIDERS.flatMap((p) => EXPECTED_FEATURES[p]));
    const unlisted = FEATURES.filter((f) => !listed.has(f));
    assert.deepEqual(unlisted, [], `features nobody requires any column to produce: ${unlisted.join(', ')}`);
  });

  it('same input, byte-identical output and report (AGENTS.md 8.2)', () => {
    for (const provider of PROVIDERS) {
      for (const item of corpus(provider, 60)) {
        const a = dedupeMessages(item.messages);
        const b = dedupeMessages(item.messages);
        assert.deepEqual(a.messages, b.messages, `seed ${item.seed} (${provider}) is nondeterministic`);
        assert.deepEqual(a.report, b.report, `seed ${item.seed} (${provider}) reported differently on a rerun`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The invariants that must not regress while the property is in place         */
/* -------------------------------------------------------------------------- */

const countType = (messages: readonly NonGovernanceMessage[], type: 'tool_use' | 'tool_result'): number =>
  flat(messages).filter((b) => b.type === type).length;

const idsOf = (messages: readonly NonGovernanceMessage[], type: 'tool_use' | 'tool_result'): Set<string> => {
  const ids = new Set<string>();
  for (const b of flat(messages)) {
    if (b.type === type && typeof b.id === 'string' && b.id !== '') ids.add(b.id);
  }
  return ids;
};

/** The shapes the four hand-picked cases in `packages/gateway/test/tool-pairing.test.ts` use. */
const twoReadsDifferentFiles = (): readonly NonGovernanceMessage[] => [
  msg('user', [textBlock('user', 'compare the two')]),
  msg('assistant', [
    callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' }),
    callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/b.ts' }, id: 'toolu_02' }),
  ]),
  msg('user', [
    resultBlock('anthropic', { id: 'toolu_01' }),
    resultBlock('anthropic', { id: 'toolu_02' }),
  ]),
];

const twoDifferentNames = (): readonly NonGovernanceMessage[] => [
  msg('user', [textBlock('user', 'look')]),
  msg('assistant', [
    callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' }),
    callBlock('anthropic', { name: 'Grep', input: { pattern: 'TODO' }, id: 'toolu_02' }),
  ]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_01' }), resultBlock('anthropic', { id: 'toolu_02' })]),
];

const twoReadsSameFile = (): readonly NonGovernanceMessage[] => [
  msg('user', [textBlock('user', 'read it twice')]),
  msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' })]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_01' })]),
  msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02' })]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_02' })]),
];

/** A failed read of a path that is later read successfully: the ENOENT case. */
const failedThenSuccessfulRead = (): readonly NonGovernanceMessage[] => [
  msg('user', [textBlock('user', 'read it')]),
  msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' })]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_01', failed: true })]),
  msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02' })]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_02' })]),
];

/** Two reads of a path whose file changed between them, on one canonical identity. */
const readBeforeAndAfterEdit = (): readonly NonGovernanceMessage[] => [
  msg('user', [textBlock('user', 'read it, then edit it, then read it again')]),
  msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01', version: 'v1' })]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_01', version: 'v1' })]),
  msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02', version: 'v2' })]),
  msg('user', [resultBlock('anthropic', { id: 'toolu_02', version: 'v2' })]),
];

describe('B-1: the pairing invariant, on the shapes that motivate it', () => {
  it('every surviving tool_use keeps a result', () => {
    // Stated over the ids that were *complete in the input*, which is the only
    // form of it dedupe can be responsible for: a pending call at the tail of a
    // turn is a legal shape with no result anywhere, and no implementation can
    // conjure one. Asserting it over every surviving `tool_use` instead makes
    // the generator's "call with no result" fault look like a product bug, which
    // is how the earlier version of this test misread one.
    for (const provider of PROVIDERS) {
      for (const item of corpus(provider)) {
        const run = dedupeMessages(item.messages);
        const complete = new Set([...halvesById(flat(item.messages))].filter(([, h]) => h.uses > 0 && h.results > 0).map(([id]) => id));
        const results = idsOf(run.messages, 'tool_result');
        for (const id of idsOf(run.messages, 'tool_use')) {
          if (!complete.has(id)) continue;
          assert.ok(results.has(id), `tool_use ${id} survived with no tool_result\n${context(item, run)}`);
        }
      }
    }
  });

  it('every surviving tool_result still has the call it names', () => {
    // The other direction. The D-11 defect only ever produced this one, so a
    // property that checks half the pair checks the half that did not break.
    for (const provider of PROVIDERS) {
      for (const item of corpus(provider)) {
        const run = dedupeMessages(item.messages);
        const complete = new Set([...halvesById(flat(item.messages))].filter(([, h]) => h.uses > 0 && h.results > 0).map(([id]) => id));
        const calls = idsOf(run.messages, 'tool_use');
        for (const id of idsOf(run.messages, 'tool_result')) {
          if (!complete.has(id)) continue;
          assert.ok(calls.has(id), `tool_result ${id} survived with no tool_use\n${context(item, run)}`);
        }
      }
    }
  });

  it('a pending call at the tail of a turn is left alone', () => {
    // The negative case for the assertion above: a transcript that legitimately
    // has half a pair must come back untouched, not "helpfully" completed.
    const input: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'read three files')]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' })]),
    ];
    const { messages, report } = dedupeMessages(input);
    assert.equal(report.dropped, 0, 'nothing here is a duplicate of anything');
    assert.equal(countType(messages, 'tool_use'), 1);
    assert.equal(countType(messages, 'tool_result'), 0, 'and the absent half is still absent, not invented');
    assert.deepEqual(pairViolations(input, messages), []);
  });

  it('an injected result with no call anywhere is deduped only on its own identity', () => {
    const input: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('tool', [resultBlock('openai-compat', { id: 'call_99' })]),
      msg('tool', [resultBlock('openai-compat', { id: 'call_99' })]),
    ];
    const { messages, report } = dedupeMessages(input);
    assert.equal(countType(messages, 'tool_result'), 1, 'the second copy of the same id goes');
    assert.equal(report.byReason.duplicate, 1);
    assert.deepEqual(pairViolations(input, messages), [], 'nothing to orphan: no call exists in the input either');
  });

  it('a failed read of a path later read successfully is retained, with its call', () => {
    // The ENOENT invariant. It depends on the *canonical* severity the adapter
    // derives from `is_error`, not on the wire flag: an adapter that dropped the
    // mapping would leave a shape where the failure is invisible to every stage
    // after ingress, and the ENOENT would be deduped away correctly.
    const input = failedThenSuccessfulRead();
    const { messages, report } = dedupeMessages(input);

    assert.deepEqual(pairViolations(input, messages), []);
    assert.equal(countType(messages, 'tool_result'), 2, 'the ENOENT survives');
    assert.equal(countType(messages, 'tool_use'), 2, 'and so does the call that produced it');
    assert.ok(
      flat(messages).some((b) => b.type === 'tool_result' && b.text?.includes('ENOENT')),
      'the error the model must not lose is still in the transcript',
    );
    assert.equal(report.retainedHighSeverity, 1);
    assert.equal(report.dropped, 0, 'the later read of the same path supersedes nothing: the failure is the evidence');
  });

  it('the ENOENT result the adapter actually emits is the severe one', () => {
    // Pins the fixture above to the provider shape, so a future edit that drops
    // the `is_error` mapping fails here rather than turning the ENOENT test into
    // a test of something else.
    const enoent = resultBlock('anthropic', { id: 'toolu_01', failed: true });
    assert.equal(enoent.meta.severity, 'error', 'anthropic-adapter.ts: is_error is the severity on an Anthropic tool_result');
    const geminiEnoent = resultBlock('gemini', { id: 'Read', name: 'Read', failed: true });
    assert.equal(geminiEnoent.meta.severity, 'error', 'and on Gemini an `error` key in the response Struct');
    assert.equal(resultBlock('openai-compat', { id: 'call_01', failed: true }).meta.severity, undefined, 'openai-compat has no failure flag, so none is invented');
  });

  it('subject.version separates a re-read from a file that changed under us', () => {
    const input = readBeforeAndAfterEdit();
    const { messages, report } = dedupeMessages(input);

    assert.deepEqual(pairViolations(input, messages), []);
    assert.equal(countType(messages, 'tool_use'), 1);
    assert.equal(countType(messages, 'tool_result'), 1);
    assert.equal(flat(messages)[1]?.id, 'toolu_02', 'the later read is the one that stays');
    assert.equal(report.dropped, 2, 'the earlier read leaves as a pair');
    assert.equal(report.byReason.superseded, 2, 'a changed file is a supersession, not a duplicate');
    assert.equal(report.byReason.duplicate, 0);
    assert.deepEqual(
      report.drops.map((d) => d.version),
      ['v1', 'v1'],
      'both halves report the version they were dropped at',
    );
  });

  it('an empty id is not a correlation, so it is outside the invariant', () => {
    // The boundary is documented (`pairIndex`: an absent or empty id cannot
    // pair) rather than enforced, and the Anthropic adapter copies whatever `id`
    // the wire carried, so a client can produce one. This test pins the
    // boundary; it does not claim a provider would accept the result. Anthropic
    // never mints an empty id.
    const input: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('assistant', [
        { ...callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' }), id: '' },
      ]),
      msg('user', [{ ...resultBlock('anthropic', { id: 'toolu_01' }), id: '' }]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_02' })]),
    ];
    const { messages } = dedupeMessages(input);

    assert.equal(countType(messages, 'tool_result'), 2, 'the pairing pass did not treat the empty id as a correlation');
    assert.equal(countType(messages, 'tool_use'), 1, 'so the empty-id call was deduped on identity alone');
  });
});

/* -------------------------------------------------------------------------- */
/* The four defects 91ec784 fixed, one hand-written case each                   */
/* -------------------------------------------------------------------------- */

/**
 * Each of these is a real, shipped defect, so each one gets a transcript small
 * enough to read in full and an assertion on the exact numbers. The generated
 * property below is what proves the *corpus* sees them; these are what stop the
 * file from being a generator and nothing else.
 */
describe('B-1: 91ec784 -- the severe half of a pair never leaves', () => {
  it('fix 1: a twin cannot stand in for itself, so a severe result keeps its call', () => {
    // `survivingTwin` used to resolve the winner's twin by id and hand back
    // `partner` when the winner was `block` itself -- the ordinary case -- so
    // `isHighSeverity(survivor)` confirmed the ENOENT against itself, the guard
    // passed, and the result left with its call. The call here is superseded by a
    // producer flag, which is how the ENOENT used to disappear.
    const input: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_01', failed: true })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01', flagged: true })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_02' })]),
    ];
    const { messages, report } = dedupeMessages(input);

    assert.equal(countType(messages, 'tool_result'), 2, 'the ENOENT is still here');
    assert.equal(countType(messages, 'tool_use'), 2, 'and so is the call that explains it');
    assert.deepEqual(pairViolations(input, messages), []);
    assert.equal(report.dropped, 0);
  });

  it('fix 2: the guard examines both halves, so a severe result before its own call is kept', () => {
    // The severe half is frequently `block` rather than `partner`. The old guard
    // asked only about the partner, found a benign call, and co-dropped the
    // severe result with it.
    const input: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_01', failed: true, flagged: true })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_02' })]),
    ];
    const { messages, report } = dedupeMessages(input);

    assert.equal(countType(messages, 'tool_result'), 2);
    assert.equal(countType(messages, 'tool_use'), 2);
    assert.equal(report.dropped, 0);
    assert.equal(report.byReason.superseded_by_flag, 0, 'fix 4 closes this from the other end');
    assert.equal(report.retainedHighSeverity, 2, 'both the flagged ENOENT and the call the pair saved');
  });

  it('fix 3: a same-version severe twin is kept unless the winner is severe in its own right', () => {
    // `decide` dropped a same-version severe block on the rationale that "the
    // surviving copy carries the same severity", which is false when the marker
    // sits on one twin only: toolu_02 was error, toolu_03 was not.
    const severeLoserBenignWinner: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01', version: 'v1', severity: 'error' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_01', version: 'v1' })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02', version: 'v1' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_02', version: 'v1' })]),
    ];
    const kept = dedupeMessages(severeLoserBenignWinner);
    assert.equal(kept.report.dropped, 0, 'the winner is not severe, so the severe twin has no replacement');
    assert.equal(kept.report.retainedHighSeverity, 1);
    assert.deepEqual(severityViolations(severeLoserBenignWinner, kept.messages), []);

    // And the other half of the rule: when the winner *is* severe, the duplicate
    // pair is free to go, and the transcript keeps an equally severe copy.
    const bothSevere: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01', version: 'v1', severity: 'error' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_01', version: 'v1', failed: true })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02', version: 'v1', severity: 'error' })]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_02', version: 'v1', failed: true })]),
    ];
    const dropped = dedupeMessages(bothSevere);
    assert.equal(dropped.report.dropped, 2, 'two blocks, one pair, and an ENOENT of the same identity still survives');
    assert.deepEqual(severityViolations(bothSevere, dropped.messages), []);
    assert.ok(flat(dropped.messages).some((b) => b.text?.includes('ENOENT')), 'the surviving copy carries the same severity');
  });

  it('fix 4: a producer flag does not override severity', () => {
    const input: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('user', [resultBlock('anthropic', { id: 'toolu_01', failed: true, flagged: true })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01' })]),
    ];
    const { messages, report } = dedupeMessages(input);

    assert.equal(countType(messages, 'tool_result'), 1, 'the flag said it was superseded; nothing superseded it');
    assert.equal(report.byReason.superseded_by_flag, 0);
    assert.equal(report.retainedHighSeverity, 1);
    assert.deepEqual(flagViolations(input, report), []);

    // And a benign block under the same flag is still honoured: the flag is not
    // broken, it is ranked.
    const benign: readonly NonGovernanceMessage[] = [
      msg('user', [textBlock('user', 'go')]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_01', flagged: true })]),
      msg('assistant', [callBlock('anthropic', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'toolu_02' })]),
    ];
    const flagged = dedupeMessages(benign);
    assert.equal(flagged.report.byReason.superseded_by_flag, 1, 'a fact beats an inference');
    assert.equal(flagged.report.retainedHighSeverity, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Is the property test vacuous?                                                */
/* -------------------------------------------------------------------------- */

/**
 * A local copy of the dedupe algorithm, switchable at every decision the fixes
 * turned on. It exists so the generated corpus can be pointed at a *deliberately
 * broken* implementation without editing `dedupe.ts` (AGENTS.md 6.1: touch only
 * the files you were given), and so the switch points are named rather than
 * described.
 *
 * The switches:
 *
 * - `callRef` / `resultRef`: the identity formula. `name` is the pre-fix stamp
 *   that produced D-11 (`toolUseSubject` in each adapter).
 * - `pairing`: the co-drop pass, `enforcePairAtomicity`.
 * - `ambiguityRefusal`: its second exit.
 * - `pairSeverity`: its third exit. `both-halves` is the current code;
 *   `partner-only` is `91ec784` fix 2; `off` is everything before `91ec784`.
 * - `twinExclusion`: `91ec784` fix 1 -- `survivingTwin`'s `excluding` and
 *   `leaving` arguments.
 * - `severeTwinNeedsSevereWinner`: `91ec784` fix 3 -- `decide`'s duplicate path.
 * - `flagOutranksSeverity`: `91ec784` fix 4 -- severity before the producer flag.
 * - `versionInKey`: whether the version is part of the drop decision.
 *
 * In its unmutated configuration it must reproduce `dedupeMessages` exactly, over
 * the whole corpus and both the messages and the report; that equality is
 * asserted below, so a mutant is a one-flag change from the real algorithm rather
 * than a strawman written to lose.
 */
interface ModelOptions {
  readonly callRef: 'name-and-args' | 'name';
  readonly resultRef: 'id' | 'name';
  readonly pairing: boolean;
  readonly ambiguityRefusal: boolean;
  readonly pairSeverity: 'both-halves' | 'partner-only' | 'off';
  readonly twinExclusion: boolean;
  readonly severeTwinNeedsSevereWinner: boolean;
  readonly flagOutranksSeverity: boolean;
  readonly versionInKey: boolean;
}

const MODEL_FIXED: ModelOptions = {
  callRef: 'name-and-args',
  resultRef: 'id',
  pairing: true,
  ambiguityRefusal: true,
  pairSeverity: 'both-halves',
  twinExclusion: true,
  severeTwinNeedsSevereWinner: true,
  flagOutranksSeverity: true,
  versionInKey: true,
};

/** Board row D-11 as measured on the Anthropic adapter: calls keyed on the name. */
const MODEL_D11_ANTHROPIC: ModelOptions = {
  callRef: 'name',
  resultRef: 'id',
  pairing: false,
  ambiguityRefusal: false,
  pairSeverity: 'off',
  twinExclusion: false,
  severeTwinNeedsSevereWinner: false,
  flagOutranksSeverity: false,
  versionInKey: true,
};

/** The Gemini variant: call *and* response shared `ref: name`. */
const MODEL_D11_GEMINI: ModelOptions = { ...MODEL_D11_ANTHROPIC, resultRef: 'name' };

/**
 * `dedupeMessages` as of `0ff31b2`, before `91ec784`. One mutant, because that is
 * what the commit was: four mechanisms, all reachable from a single transcript,
 * and none of them reachable from the four hand-picked cases.
 */
const MODEL_PRE_91EC784: ModelOptions = {
  ...MODEL_FIXED,
  pairSeverity: 'partner-only',
  twinExclusion: false,
  severeTwinNeedsSevereWinner: false,
  flagOutranksSeverity: false,
};

/** Correct identity, but the pair-severity rule is gone entirely. */
const MODEL_NO_PAIR_SEVERITY: ModelOptions = { ...MODEL_FIXED, pairSeverity: 'off' };

/** Correct identity, but an id shared by two calls is no longer treated as ambiguous. */
const MODEL_NO_AMBIGUITY_REFUSAL: ModelOptions = { ...MODEL_FIXED, ambiguityRefusal: false };

/** Correct everything except the version in the drop key: a changed file reads as a duplicate. */
const MODEL_NO_VERSION_IN_KEY: ModelOptions = { ...MODEL_FIXED, versionInKey: false };

const modelIdentityKey = (s: BlockSubject): string => `${s.kind}\u0000${s.ref}`;

const modelSubject = (block: NonGovernanceBlock, options: ModelOptions): BlockSubject | undefined => {
  if (block.type === 'tool_use' && options.callRef === 'name') {
    return block.toolName === undefined ? undefined : subject('other', block.toolName, block.meta.subject?.version);
  }
  if (block.type === 'tool_result' && options.resultRef === 'name') {
    const ref = block.toolName ?? block.id;
    return ref === undefined ? undefined : subject('other', ref, block.meta.subject?.version);
  }
  return block.meta.subject;
};

const modelVersionKey = (s: BlockSubject, options: ModelOptions): string =>
  options.versionInKey ? `${modelIdentityKey(s)}\u0000${s.version ?? ''}` : modelIdentityKey(s);

const modelStamp = (b: NonGovernanceBlock): string => b.meta.subject?.version ?? b.meta.sha256;

const modelDedupe = (
  input: readonly NonGovernanceMessage[],
  options: ModelOptions,
): { readonly messages: readonly NonGovernanceMessage[]; readonly report: DedupeReport } => {
  const blocks = flat(input);
  const lastByIdentity = new Map<string, number>();
  for (const [i, b] of blocks.entries()) {
    const s = modelSubject(b, options);
    if (s !== undefined) lastByIdentity.set(modelIdentityKey(s), i);
  }

  const dropAt = new Set<number>();
  const dropByIndex = new Map<number, NonNullable<DedupeReport['drops'][number]>>();
  let retainedHighSeverity = 0;
  let untiered = 0;

  for (const [i, block] of blocks.entries()) {
    if (block.meta.subject === undefined) untiered += 1;
    const s = modelSubject(block, options);
    if (s === undefined) continue;

    if (block.meta.supersededBy !== undefined) {
      if (options.flagOutranksSeverity && isHighSeverity(block)) {
        retainedHighSeverity += 1;
        continue;
      }
      dropAt.add(i);
      dropByIndex.set(i, {
        sha256: block.meta.sha256,
        ref: s.ref,
        version: s.version,
        reason: 'superseded_by_flag',
        supersededBy: block.meta.supersededBy,
      });
      continue;
    }

    const last = lastByIdentity.get(modelIdentityKey(s));
    if (last === undefined || last <= i) continue;
    const winner = blocks[last];
    if (winner === undefined) continue;
    const winnerSubject = modelSubject(winner, options) ?? s;
    const sameVersion = modelVersionKey(s, options) === modelVersionKey(winnerSubject, options);
    const sameSeverity = !options.severeTwinNeedsSevereWinner || isHighSeverity(winner);
    if (isHighSeverity(block) && (!sameVersion || !sameSeverity)) {
      retainedHighSeverity += 1;
      continue;
    }
    dropAt.add(i);
    dropByIndex.set(i, {
      sha256: block.meta.sha256,
      ref: s.ref,
      version: s.version,
      reason: sameVersion ? 'duplicate' : 'superseded',
      supersededBy: modelStamp(winner),
    });
  }

  if (options.pairing) {
    const uses = new Map<string, number[]>();
    const results = new Map<string, number[]>();
    for (const [i, b] of blocks.entries()) {
      if (!isHalf(b)) continue;
      const table = b.type === 'tool_use' ? uses : results;
      const at = table.get(b.id);
      if (at === undefined) table.set(b.id, [i]);
      else at.push(i);
    }
    const coDrops = new Map<number, NonNullable<DedupeReport['drops'][number]>>();
    const retained = new Set<number>();
    const leaving = (index: number): boolean => dropAt.has(index) || coDrops.has(index);

    const survivingTwin = (
      block: NonGovernanceBlock,
      table: ReadonlyMap<string, number[]>,
      excluding: number,
    ): NonGovernanceBlock | undefined => {
      const s = modelSubject(block, options);
      if (s === undefined) return undefined;
      const winnerIndex = lastByIdentity.get(modelIdentityKey(s));
      if (winnerIndex === undefined) return undefined;
      const winner = blocks[winnerIndex];
      if (winner === undefined) return undefined;
      const twinIndex = isHalf(winner) ? table.get(winner.id)?.[0] : undefined;
      if (twinIndex === undefined) return undefined;
      if (options.twinExclusion) {
        if (twinIndex === excluding) return undefined;
        if (leaving(twinIndex)) return undefined;
      }
      return blocks[twinIndex];
    };

    for (const [i, block] of blocks.entries()) {
      if (!dropAt.has(i) || !isHalf(block)) continue;
      const own = block.type === 'tool_use' ? uses : results;
      const other = block.type === 'tool_use' ? results : uses;
      const counterparts = other.get(block.id);
      if (counterparts === undefined || counterparts.length === 0) continue;
      const ownCount = own.get(block.id)?.length ?? 0;
      if (options.ambiguityRefusal && (counterparts.length > 1 || ownCount > 1)) {
        dropAt.delete(i);
        continue;
      }
      const partnerAt = counterparts[0];
      if (partnerAt === undefined) continue;
      if (leaving(partnerAt)) continue;
      const partner = blocks[partnerAt];
      if (partner === undefined) continue;

      const survivor = survivingTwin(block, other, partnerAt);
      const severe = isHighSeverity(block) ? i : isHighSeverity(partner) ? partnerAt : undefined;
      if (options.pairSeverity === 'off') {
        // No guard at all: co-drop unconditionally. (Pre-`91ec784` with no
        // severity rule in the pairing pass.)
      } else if (options.pairSeverity === 'partner-only') {
        if (isHighSeverity(partner) && (survivor === undefined || !isHighSeverity(survivor))) {
          dropAt.delete(i);
          retained.add(partnerAt);
          continue;
        }
      } else if (severe !== undefined && (survivor === undefined || !isHighSeverity(survivor))) {
        dropAt.delete(i);
        dropAt.delete(partnerAt);
        retained.add(severe);
        continue;
      }

      const sameContent = survivor !== undefined && partner.meta.sha256 === survivor.meta.sha256;
      coDrops.set(partnerAt, {
        sha256: partner.meta.sha256,
        ref: modelSubject(partner, options)?.ref ?? partner.id ?? '',
        version: modelSubject(partner, options)?.version,
        reason: sameContent && block.meta.supersededBy === undefined ? 'duplicate' : 'superseded',
        supersededBy: survivor === undefined ? modelStamp(block) : modelStamp(survivor),
      });
      dropAt.add(partnerAt);
    }
    retainedHighSeverity += retained.size;
    for (const [i, drop] of coDrops) dropByIndex.set(i, drop);
  }

  const order = [...dropAt].sort((a, b) => a - b);
  const drops = order.flatMap((i) => {
    const drop = dropByIndex.get(i);
    return drop === undefined ? [] : [drop];
  });
  const byReason = { superseded_by_flag: 0, duplicate: 0, superseded: 0, retained_severity: 0 };
  for (const drop of drops) byReason[drop.reason] += 1;

  if (dropAt.size === 0) {
    return { messages: input, report: { dropped: 0, byReason, retainedHighSeverity, untiered, mergedMessages: 0, drops } };
  }

  let cursor = 0;
  const rebuilt: NonGovernanceMessage[] = [];
  for (const m of input) {
    const content: NonGovernanceBlock[] = [];
    let touched = false;
    for (const b of m.content) {
      if (dropAt.has(cursor)) touched = true;
      else content.push(b);
      cursor += 1;
    }
    if (content.length === 0) continue;
    rebuilt.push(touched ? { ...m, content } : m);
  }
  const out = mergeAdjacentSameRole(rebuilt);
  return {
    messages: out,
    report: {
      dropped: order.length,
      byReason,
      retainedHighSeverity,
      untiered,
      mergedMessages: rebuilt.length - out.length,
      drops,
    },
  };
};

describe('B-1: the property test is not vacuous', () => {
  it('the local model reproduces dedupeMessages exactly, so a mutant is one flag away', () => {
    let compared = 0;
    for (const provider of PROVIDERS) {
      for (const item of corpus(provider)) {
        const real = dedupeMessages(item.messages);
        const model = modelDedupe(item.messages, MODEL_FIXED);
        const where = context(item, real);
        assert.deepEqual(model.report, real.report, `the model disagrees about the report\n${where}`);
        assert.deepEqual(model.messages, real.messages, `the model disagrees about the output\n${where}`);
        if (real.report.dropped > 0 || real.report.retainedHighSeverity > 0) compared += 1;
      }
    }
    assert.ok(
      compared > (PROVIDERS.length * SEED_COUNT) / 2,
      `only ${compared} cases had anything to decide, so the model is barely exercised`,
    );
  });

  it('the D-11 model reproduces the recorded defect, so it is the defect and not a strawman', () => {
    const twoFiles = modelDedupe(twoReadsDifferentFiles(), MODEL_D11_ANTHROPIC);
    assert.equal(twoFiles.report.dropped, 1);
    assert.equal(countType(twoFiles.messages, 'tool_use'), 1, 'the losing call was dropped');
    assert.deepEqual(pairViolations(twoReadsDifferentFiles(), twoFiles.messages), [
      'id toolu_01: input had 1 use(s)/1 result(s), output kept 0 use(s)/1 result(s)',
    ]);

    const sameFile = modelDedupe(twoReadsSameFile(), MODEL_D11_ANTHROPIC);
    assert.equal(sameFile.report.dropped, 1, 'a true duplicate orphaned its result too');
    assert.equal(pairViolations(twoReadsSameFile(), sameFile.messages).length, 1);

    const gemini = modelDedupe(
      [
        msg('user', [textBlock('user', 'go')]),
        msg('assistant', [
          callBlock('gemini', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'Read' }),
          callBlock('gemini', { name: 'Read', input: { file_path: '/repo/b.ts' }, id: 'Read' }),
        ]),
        msg('user', [
          resultBlock('gemini', { id: 'Read', name: 'Read' }),
          resultBlock('gemini', { id: 'Read', name: 'Read' }),
        ]),
      ],
      MODEL_D11_GEMINI,
    );
    assert.equal(gemini.report.dropped, 3, 'both calls and one response left, as the adapter header recorded');
    assert.equal(countType(gemini.messages, 'tool_use'), 0);
    assert.equal(gemini.report.byReason.duplicate, 3);
    assert.equal(
      pairViolations(
        [
          msg('user', [textBlock('user', 'go')]),
          msg('assistant', [
            callBlock('gemini', { name: 'Read', input: { file_path: '/repo/a.ts' }, id: 'Read' }),
            callBlock('gemini', { name: 'Read', input: { file_path: '/repo/b.ts' }, id: 'Read' }),
          ]),
          msg('user', [
            resultBlock('gemini', { id: 'Read', name: 'Read' }),
            resultBlock('gemini', { id: 'Read', name: 'Read' }),
          ]),
        ],
        gemini.messages,
      ).length,
      1,
      'the one surviving response has no call',
    );

    // And the fixed implementation is clean on all of them.
    for (const transcript of [twoReadsDifferentFiles(), twoReadsSameFile(), failedThenSuccessfulRead()]) {
      assert.deepEqual(pairViolations(transcript, dedupeMessages(transcript).messages), []);
    }
  });

  it('the generated corpus flags every broken model, and says which oracle saw it', () => {
    interface Mutant {
      readonly name: string;
      readonly options: ModelOptions;
      /** What has to be true of the corpus for this fault to count as caught. */
      readonly expected: readonly ('pair' | 'severity' | 'flag' | 'report')[];
      /**
       * Faults the shapes `packages/gateway/test/tool-pairing.test.ts` hard-codes
       * as of `0ff31b2` must *not* see, to show what they missed. This is the
       * whole justification for the file: those cases shipped with the D-11 fix
       * and all four `91ec784` mechanisms got through them.
       */
      readonly invisibleToHistory?: boolean;
    }
    const mutants: readonly Mutant[] = [
      {
        // No `invisibleToHistory`: the ENOENT shape *does* see D-11, and it is one
        // of the shapes the gateway file shipped with, so a claim that the fix's
        // own cases missed it would be false. They missed the four mechanisms
        // below, which is a different and accurate statement.
        name: 'pre-fix identity, no pairing pass (D-11, anthropic)',
        options: MODEL_D11_ANTHROPIC,
        expected: ['pair'],
      },
      {
        name: 'pre-fix identity, call and response sharing ref:name (D-11, gemini)',
        options: MODEL_D11_GEMINI,
        expected: ['pair'],
      },
      {
        name: 'dedupeMessages as of 0ff31b2, before the severity fix (91ec784)',
        options: MODEL_PRE_91EC784,
        expected: ['severity'],
        invisibleToHistory: true,
      },
      {
        name: 'pairing pass without the ambiguity refusal',
        options: MODEL_NO_AMBIGUITY_REFUSAL,
        expected: ['pair'],
      },
      {
        name: 'pairing pass without the pair-severity refusal',
        options: MODEL_NO_PAIR_SEVERITY,
        // Not `pair`: dropping the severe half still leaves a legal request, so
        // the pairing property is blind to this fault by construction.
        expected: ['severity'],
      },
      {
        name: 'drop key without subject.version',
        options: MODEL_NO_VERSION_IN_KEY,
        expected: ['report'],
        // No shape in the gateway file carries a version, so the report is the
        // only oracle that can see this one -- and it is the reason this file
        // adds `readBeforeAndAfterEdit`. That addition used to sit in the
        // hand-picked list below, which is what made this expectation fail for
        // the uninteresting reason that the list was not the list it claimed to
        // be: the list is what `0ff31b2` shipped, and this shape is not in it.
        invisibleToHistory: true,
      },
    ];

    /** Which oracles, if any, reject one transcript's mutant output. */
    const verdicts = (
      input: readonly NonGovernanceMessage[],
      options: ModelOptions,
    ): Set<'pair' | 'severity' | 'flag' | 'report'> => {
      const out = modelDedupe(input, options);
      const found = new Set<'pair' | 'severity' | 'flag' | 'report'>();
      if (pairViolations(input, out.messages).length > 0) found.add('pair');
      if (severityViolations(input, out.messages).length > 0) found.add('severity');
      if (flagViolations(input, out.report).length > 0) found.add('flag');
      // The reference labelling is the real implementation's, case for case: a
      // mutant that changes which drop is a `duplicate` and which is a
      // `supersession` has changed the report telemetry claims to carry.
      if (JSON.stringify(out.report.byReason) !== JSON.stringify(dedupeMessages(input).report.byReason)) found.add('report');
      return found;
    };

    /**
     * Exactly the shapes `packages/gateway/test/tool-pairing.test.ts` hard-codes
     * as of `0ff31b2`: two Reads of different files, two calls of different names,
     * a genuine duplicate, and the ENOENT. The other two `describe` blocks in that
     * file (three same-name calls, and the same two-call turn through each of the
     * three adapters) are the same three transcripts reached a different way, so
     * they add nothing to an invisibility claim.
     *
     * `readBeforeAndAfterEdit` is deliberately *not* in this list. It is this
     * file's addition, it carries a `subject.version`, and it is precisely the
     * version-blind mutant's witness; an earlier version put it here and the
     * expectation that followed then failed for the uninteresting reason that the
     * list was not the list it said it was.
     */
    const historical = [
      twoReadsDifferentFiles(),
      twoDifferentNames(),
      twoReadsSameFile(),
      failedThenSuccessfulRead(),
    ];

    for (const mutant of mutants) {
      const tally: Record<'pair' | 'severity' | 'flag' | 'report', number> = { pair: 0, severity: 0, flag: 0, report: 0 };
      let witnesses = 0;
      for (const provider of PROVIDERS) {
        for (const item of corpus(provider, 120)) {
          for (const verdict of verdicts(item.messages, mutant.options)) {
            tally[verdict] += 1;
            witnesses += 1;
          }
        }
      }

      const missed = mutant.expected.filter((o) => tally[o] === 0);
      assert.deepEqual(
        missed,
        [],
        `mutant "${mutant.name}": the corpus never saw ${missed.join('/')}; counts ${JSON.stringify(tally)}`,
      );
      assert.ok(witnesses > 0, `mutant "${mutant.name}" passes the whole corpus`);

      const historyVerdicts = new Set(historical.flatMap((t) => [...verdicts(t, mutant.options)]));
      if (mutant.invisibleToHistory === true) {
        assert.deepEqual(
          [...historyVerdicts],
          [],
          `mutant "${mutant.name}" was expected to be invisible to the four hand-picked shapes, and it is not: ${[...historyVerdicts].join('/')}`,
        );
      }
    }
  });

  it('each of the four 91ec784 mechanisms is exercised on its own, not only in combination', () => {
    // `MODEL_PRE_91EC784` is all four at once, which is the commit. Individually,
    // they are four independent switches, and a corpus that only catches the
    // combination has measured nothing about any of them: one mutant could be
    // masking another, and the next person to break one would find a green run.
    const mechanisms: readonly { readonly name: string; readonly options: ModelOptions }[] = [
      { name: 'fix 1: a twin that may stand in for itself', options: { ...MODEL_FIXED, twinExclusion: false } },
      { name: 'fix 2: a guard that examines only the partner', options: { ...MODEL_FIXED, pairSeverity: 'partner-only' } },
      { name: 'fix 3: a same-version severe twin dropped unconditionally', options: { ...MODEL_FIXED, severeTwinNeedsSevereWinner: false } },
      { name: 'fix 4: a producer flag that outranks severity', options: { ...MODEL_FIXED, flagOutranksSeverity: false } },
    ];
    // Two levels of evidence, because the four are not equally observable.
    //
    // The strong one is a semantic violation -- a severity fact the mutant lost,
    // or a flag it honoured. Fixes 1, 3 and 4 produce those.
    //
    // Fix 2 does not, and the reason is worth stating rather than papering over.
    // `partner-only` diverges from `dedupeMessages` on 4 of 900 corpus cases, but
    // in every one of them a *twin* severe call of the same identity survives, so
    // no severity fact is actually lost: the mutant co-drops the severe half
    // together with its benign partner, and the winner of that identity is severe
    // in its own right. `severityViolations` is written to demand a surviving
    // severe call *of that identity*, not merely a surviving severe block, so
    // those 4 cases are not violations and the file must not pretend otherwise.
    //
    // So for fix 2 the evidence is divergence from the implementation instead,
    // which is legitimate here because the first test in this suite pins the
    // model to `dedupeMessages` on every corpus case: if reverting one switch
    // changes the output, that switch is load-bearing on this corpus.
    for (const mechanism of mechanisms) {
      let total = 0;
      let diverged = 0;
      let flagged = 0;
      for (const provider of PROVIDERS) {
        for (const item of corpus(provider, 120)) {
          const real = dedupeMessages(item.messages);
          const out = modelDedupe(item.messages, mechanism.options);
          total += 1;
          if (
            JSON.stringify(real.report) !== JSON.stringify(out.report) ||
            JSON.stringify(real.messages) !== JSON.stringify(out.messages)
          ) {
            diverged += 1;
          }
          if (
            severityViolations(item.messages, out.messages).length > 0 ||
            flagViolations(item.messages, out.report).length > 0
          ) {
            flagged += 1;
          }
        }
      }
      assert.ok(
        diverged > 0,
        `${mechanism.name}: identical output on all ${total} corpus cases, so nothing in this file would have noticed the regression`,
      );
      assert.ok(diverged < total, `${mechanism.name}: diverges on every one of ${total} cases, which means the corpus was built for it`);
      if (mechanism.options.pairSeverity !== 'partner-only') {
        assert.ok(
          flagged > 0,
          `${mechanism.name}: ${diverged}/${total} cases diverged but none is a semantic violation, so the divergence is unexplained by any oracle in this file`,
        );
      }
    }
  });
});