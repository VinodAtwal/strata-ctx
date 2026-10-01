import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import type { Arm, EvalConstraint } from '../src/types.js';

import {
  E6_ARMS,
  E6_ARM_MODES,
  E6_BENIGN_CORPUS,
  E6_FALSE_POSITIVE_UNUSABLE_RATE,
  E6_INSERTION_POINT_NAMES,
  E6_MINIMUM_ENTRIES_PER_SECRET_KIND,
  E6_MINIMUM_SECRET_LENGTH,
  E6_RECALL_CONFIDENCE,
  E6_RECALL_OBSERVATION_TARGET,
  E6_SECRET_CORPUS,
  E6_SECRET_KINDS,
  E6_SUITE_ID,
  E6_SINK_CATEGORIES,
  E6_WRITER_CATEGORIES,
  E6_WRITER_NAMES,
  E6BindingError,
  E6FixtureError,
  E6RedactorError,
  G9_RECALL_THRESHOLD,
  applyE6Redaction,
  assertE6Binding,
  auditE6Run,
  buildE6CaseFields,
  buildE6Document,
  buildE6Fixture,
  createE6ArmRunner,
  createE6ReferenceWriters,
  createE6TeeWriter,
  e6AllLeakMarkers,
  e6LeakMarker,
  e6StoredBytesHold,
  evaluateE6Gates,
  lintE6Corpus,
  measureE6FalsePositives,
  renderE6Carrier,
  renderE6WriteContent,
  runE6BlockProbe,
  runE6Case,
  runE6Suite,
  summariseE6Recall,
  summariseE6Sinks,
  validateE6Document,
  type E6ArmSummary,
  type E6Benign,
  type E6InsertionPointName,
  type E6RedactionMode,
  type E6RedactionOutcome,
  type E6Redactor,
  type E6RedactorBinding,
  type E6RedactorFinding,
  type E6Secret,
  type E6SecretKind,
  type E6SinkField,
  type E6SinkWriter,
  type E6SinkWrite,
} from '../src/suites/e6-redaction.js';

/* -------------------------------------------------------------------------- */
/* An offline redactor, written from shapes                                   */
/* -------------------------------------------------------------------------- */

/**
 * The subject under test, faked — and it is fake on purpose.
 *
 * `packages/eval` has no dependencies and no project reference, so this cannot
 * import `@strata-ctx/security`'s `RedactionEngine`. What it *can* do is
 * implement the same four modes over a rule set derived from **shapes**, and that
 * is a stronger test than importing the real thing would be: a suite wired
 * straight to the production redactor can only ever confirm that the production
 * redactor does what the production redactor does. Wired to a fake, the same
 * suite can be pointed at a redactor that measurably fails — which is how the
 * negative controls, the mutation test and the false-positive tests below are
 * built.
 *
 * The rules below were written against *documented credential formats*, not
 * against `E6_SECRET_CORPUS`. No rule here names, contains, or matches a corpus
 * value, and nothing imports the corpus to decide what to redact — so a corpus
 * entry this fake misses is a real miss that the report has to show. Where the
 * fake is stricter than production (the JSON-quoted `"KEY": "value"` form that
 * `assigned_secret` does not match) that is stated in the rule comment, and it
 * is the direction that makes the fake's 100% recall less impressive rather than
 * more.
 */
interface FakeSpan {
  readonly start: number;
  readonly end: number;
  readonly ruleId: string;
  readonly kind: E6SecretKind;
  readonly confidence: E6RedactorFinding['confidence'];
}

interface FakeRule {
  readonly ruleId: string;
  readonly kind: E6SecretKind;
  readonly confidence: E6RedactorFinding['confidence'];
  readonly pattern: RegExp;
  /** Capture group to redact, or 0 for the whole match. */
  readonly group: number;
  /** Veto a match, the way `minified_asset` and the integrity rules do. */
  readonly accept?: (value: string) => boolean;
}

const shannonBits = (token: string): number => {
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
};

const characterClasses = (value: string): number =>
  [/[a-z]/.test(value), /[A-Z]/.test(value), /[0-9]/.test(value), /[^A-Za-z0-9]/.test(value)].filter(
    Boolean,
  ).length;

/** One credential-ish run of characters, for the calibration measurements below. */
const TOKEN_RUN = /[^\s'"=:,;()[\]{}/\\]+/g;

/**
 * `isDocPlaceholderValue`, in spirit: the value on the right of an assignment is
 * not a credential if it is obviously a stand-in. `SESSION_SECRET=changeme` is
 * the documented example, and without this brake the fake rewrites the sharpest
 * benign control in the set and E6's false-positive column turns into noise.
 *
 * A *leading* placeholder, and deliberately not a whole-value match, because a
 * carrier glues prose onto the value. The `.env.example` control is
 * `SESSION_SECRET=changeme`, and the same control reaches the suite four
 * different ways: as `SESSION_SECRET=changeme. I will pass …` in agent prose, and
 * as `SESSION_SECRET=changeme/session.jsonl` in a directory name. A brake
 * anchored at both ends declines all three of the glued forms and keeps the one
 * shape nobody writes; the property that actually holds is "the first segment of
 * this value is a documented placeholder", and that is what is tested.
 */
const PLACEHOLDER_LEAD =
  /^(?:change[-_]?me|your[-_.][\w-]*|<[^>]*>|\$\{[^}]*\}|\$\([^)]*\)|\{\{[^}]*\}\}|x{3,}|\*{3,}|placeholder|redacted|example|dummy|sample|fake|none|null|undefined|todo|insert[-_]?\w*|replace[-_]?\w*|__\w+__)/i;

/** Path and sentence delimiters. The first segment of a value ends at one. */
const VALUE_SEGMENT_BREAK = /[/\\.,;:)'"]/;

/**
 * The floor below which an assigned value is not a credential.
 *
 * `entropy.ts` rejects a short token outright (`reject('too_short')`); this is
 * the same idea for the rule that has already found a credential *keyword*, and
 * 16 rather than `DEFAULT_ENTROPY_MIN_LENGTH`'s 24 because a keyword anchor and
 * a length floor are not the same amount of evidence. It has to stay below the
 * shortest value in the corpus, which the suite asserts.
 */
const MIN_ASSIGNED_VALUE_LENGTH = 16;

/**
 * `sha`-prefixed integrity values, which are longer and *more* entropic than most
 * secrets. Searched, not anchored: a lockfile hash reaches this suite as
 * `url=sha512-…` in a commit message and as `var/log/strata/sha512-…/session.jsonl`
 * in a directory name, and an anchored pattern is a brake that only works in the
 * one carrier where the value happens to stand alone.
 */
const INTEGRITY_FORMAT = /sha(?:1|224|256|384|512)-/i;

/**
 * A run of hex, with no algorithm prefix to give it away.
 *
 * Searched for the same reason, and bounded on both sides by a non-alphanumeric
 * so that `café9f86d0…` cannot smuggle a digest past it by prefixing a letter.
 * A hex run of 32 or more is a content hash — md5, sha1, a git object id, an
 * SRI body — and none of those is a credential anybody generates.
 */
const HEX_RUN = /(?:^|[^0-9A-Za-z])[0-9a-f]{32,128}(?:$|[^0-9A-Za-z])/i;

/**
 * A content-hashed build artefact: `.8c41d90b2e5f7a13.min.js`.
 *
 * The hash segment is what identifies it, not the extension — the same string
 * appears as a bare path, with a trailing full stop in prose, and inside
 * `var/log/strata/…/session.jsonl`, and an extension-anchored pattern misses two
 * of the three.
 */
const CONTENT_HASHED_ASSET =
  /\.[0-9a-f]{8,}\.(?:min\.)?(?:js|mjs|cjs|css|map|woff2?|ttf|otf|png|jpe?g|gif|webp|ico|svg|html)\b/i;

/**
 * The value-level brakes, applied to a match from *every* rule.
 *
 * Not on the entropy rule alone, and that is the whole lesson of this fake's
 * first run. The sharpest control in the set — an npm integrity hash — arrives
 * under an `x-api-key` header, so the *assignment* rule matched it and rewrote a
 * lockfile hash while the entropy rule sat there correctly declining to. A brake
 * that only one rule can reach is not a brake; `isDocPlaceholderValue` and the
 * format checks in `packages/security/src/patterns.ts` run on the matched value
 * regardless of which rule matched it, and these do the same.
 */
const valueIsRedactable = (value: string): boolean => {
  const head = value.split(VALUE_SEGMENT_BREAK, 1)[0] ?? '';
  // The placeholder question has to be asked about the value, not about the
  // assignment wrapped around it. A carrier that glues a `.env.example` control
  // into a directory name produces `SESSION_SECRET=changeme/session.jsonl`, and
  // the leading segment of *that* is the keyword `SESSION_SECRET` — so a test on
  // the head alone declines a brake whose whole subject is on the right of the
  // `=`. Which is what the entropy rule hands over: its token class includes `=`,
  // so a control planted at `filename` arrives as one 37-character token.
  const assigned = value.includes('=') ? value.split('=').at(-1) ?? '' : '';
  const assignedHead = assigned.split(VALUE_SEGMENT_BREAK, 1)[0] ?? '';
  if (PLACEHOLDER_LEAD.test(head) || PLACEHOLDER_LEAD.test(assignedHead)) return false;
  if (INTEGRITY_FORMAT.test(value)) return false;
  if (HEX_RUN.test(value)) return false;
  if (CONTENT_HASHED_ASSET.test(value)) return false;
  return true;
};

/**
 * 4.2 bits per character, and it is not a tuning knob.
 *
 * Entropy is bounded by `log2(alphabet)`, so a 16-symbol alphabet such as hex
 * cannot exceed 4.0 bits/char and any threshold above 4.0 can *never* fire on a
 * digest however long it is. That is a proof rather than a measurement, and it is
 * the same argument, at the same number, as `DEFAULT_ENTROPY_THRESHOLD` in
 * `packages/security/src/entropy.ts`.
 *
 * Both ends of the number are measured in the calibration test below rather than
 * asserted here, because they are measurements and comments drift: the three
 * `high_entropy` specimens score 5.37–5.38 bits, so the margin below them is 1.2
 * bits wide; and the highest-scoring benign token in the set is an npm integrity
 * body at 5.79 bits — *above* every secret in the corpus. The corpora overlap on
 * this scale, which is the whole reason `valueIsRedactable` exists, and it is why
 * the floor cannot be "tuned up" to separate them: no number on this scale does.
 *
 * Raising it to 4.2 also makes `HEX_RUN` belt-and-braces rather than load-bearing
 * for a bare digest, which is the intended direction — the brake that has to stay
 * is the one no measurement can replace.
 */
const ENTROPY_MINIMUM_BITS = 4.2;
const ENTROPY_MINIMUM_LENGTH = 32;
const ENTROPY_MINIMUM_CLASSES = 3;

/** `data:` URIs. Real, inert, and higher-entropy than half the corpus. */
const DATA_URI = /data:[^\s'"<>()]*/g;

const FAKE_RULES: readonly FakeRule[] = [
  {
    ruleId: 'pem_private_key',
    kind: 'private_key',
    confidence: 'certain',
    pattern: /-----BEGIN (?:[A-Z0-9]{0,32} )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]{0,32} )?PRIVATE KEY-----/g,
    group: 0,
  },
  {
    ruleId: 'jwt',
    kind: 'jwt',
    confidence: 'certain',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    group: 0,
  },
  {
    ruleId: 'aws_access_key_id',
    kind: 'aws_key',
    confidence: 'certain',
    pattern: /\b(?:AKIA|ASIA|ABIA)[A-Z0-9]{16}\b/g,
    group: 0,
  },
  {
    ruleId: 'vendor_prefixed_key',
    kind: 'api_key',
    confidence: 'certain',
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9-]{19,}/g,
    group: 0,
  },
  {
    ruleId: 'dsn_password',
    kind: 'connection_string',
    confidence: 'certain',
    // Group 1 only. The host and database name are what an operator needs in
    // order to rotate the credential, so redacting the whole DSN would be a
    // redaction that removes the reason to rotate it.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:([^\s/@"']{6,})@/g,
    group: 1,
  },
  {
    ruleId: 'authorization_credential',
    kind: 'bearer_token',
    confidence: 'certain',
    pattern: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/g,
    group: 1,
  },
  {
    ruleId: 'secret_assignment',
    kind: 'env_value',
    confidence: 'probable',
    // Matches `KEY=value`, `"key": "value"` and `password: "value"` alike. The
    // JSON-quoted form is the documented gap in the production catalogue
    // (TODO(WS-F, F2)), so this rule is deliberately one shape ahead of it.
    //
    // The value runs to the carrier's delimiter — a newline, a closing quote, or
    // a path separator — and *not* to the next space. That is the difference
    // between reading a header value and reading a word: `x-api-key: "FAIL
    // test/…"` is a test runner's output that a tool happened to dump, while
    // `x-api-key: "sk-ant-…"` is a credential, and a value capture that stops at
    // the first space cannot tell them apart — it sees `FAIL` in both. The
    // accept below is what tells them apart, and production makes the same trade
    // in `entropy.ts` (`if (/\s/.test(token)) return reject('whitespace')`).
    //
    // `/` ends the value because that is where an assignment's value ends: the
    // `.env` secret reaches the suite as a *directory* name,
    // `var/log/strata/DB_PASSWORD=e6Env01FixturePasswordNotReal/session.jsonl`,
    // and the password is the segment before the slash. Stopping there is also
    // what stops the asset controls, which arrive under an `x-api-key` header as
    // `public/fonts/inter-var-latin.woff2?v=3f9a1c2b` — a path that is not a
    // credential, and whose first segment is not either.
    pattern:
      /(?:^|[^A-Za-z0-9_])((?:[A-Za-z0-9]{1,8}[_-])?(?:password|passwd|secret|token|api[_-]?key|dsn))["']?\s*[:=]\s*["']?([^\n"'/,;}]+)/gi,
    group: 2,
    // A credential is a single token, and not a very short one.
    //
    // Whitespace: anything with a space in it is a sentence, a diff, a stack
    // frame or a multi-line blob, and redacting it destroys output without
    // protecting anything. Length: the `tool_result` carrier declares its value
    // a credential twice, in `"credential"` and in an `x-api-key` header, so the
    // three asset controls arrive as `x-api-key: "dist"`, `x-api-key: "data:image"`
    // and `x-api-key: "data:font"`. Those are a build path and two URI schemes
    // and no redactor should have to know that — the floor is what rules them
    // out, and it is the same floor `packages/security/src/entropy.ts` applies
    // with `reject('too_short')`. It sits at 16 rather than production's 24
    // because the keyword anchor is stronger evidence than entropy alone, and it
    // is below the shortest value in the corpus (30) so it costs no recall; the
    // test `keeps the assigned-value floor below every corpus secret` says so out
    // loud rather than leaving it to be checked by reading this comment.
    //
    // The cost of the whitespace half is stated rather than hidden: a password
    // that really does contain a space would not be caught here. No corpus entry
    // does, so the suite cannot measure the cost, which makes it a known limit
    // and not a measured one. `TODO(WS-F, F2)` re-measures it against the
    // production catalogue, whose value capture is delimiter-based for the same
    // reason.
    accept: (value) => !/\s/.test(value) && value.length >= MIN_ASSIGNED_VALUE_LENGTH,
  },
  {
    ruleId: 'opaque_high_entropy_token',
    kind: 'high_entropy',
    confidence: 'possible',
    pattern: /[A-Za-z0-9_+/.=-]{32,}/g,
    group: 0,
    accept: (value) => {
      if (value.length < ENTROPY_MINIMUM_LENGTH) return false;
      if (characterClasses(value) < ENTROPY_MINIMUM_CLASSES) return false;
      // An npm integrity hash scores *higher* on Shannon entropy than an opaque
      // API token does, so entropy alone cannot separate them; only the format
      // brake in `valueIsRedactable` can.
      return shannonBits(value) >= ENTROPY_MINIMUM_BITS;
    },
  },
];

const detectSpans = (text: string, rules: readonly FakeRule[], brakes: boolean): readonly FakeSpan[] => {
  // Blanked, not deleted: offsets stay aligned with the original string so every
  // rule indexes into the same coordinate space.
  let scannable = text;
  const blanked: [number, number][] = [];
  for (const match of text.matchAll(DATA_URI)) {
    const blank = ' '.repeat(match[0].length);
    scannable = scannable.slice(0, match.index) + blank + scannable.slice(match.index + match[0].length);
    blanked.push([match.index, match.index + match[0].length]);
  }

  const spans: FakeSpan[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('d') ? rule.pattern.flags : `${rule.pattern.flags}d`);
    for (const match of scannable.matchAll(pattern)) {
      const group = rule.group === 0 ? (match.indices?.[0] ?? null) : (match.indices?.[rule.group] ?? null);
      if (group === null) continue;
      // A span inside a blanked data URI is a span the rules were not supposed
      // to see at all. Without this the blanking achieves nothing: the offsets
      // align, so `text.slice` below hands back the *original* base64 payload
      // and `secret_assignment` reports the very region that was blanked out of
      // the scannable copy — an `x-api-key` header whose value is an inline
      // image, flagged and rewritten on the strength of the base64.
      if (blanked.some(([start, end]) => group[0] < end && start < group[1])) continue;
      const value = text.slice(group[0], group[1]);
      if (value === '' || value.trim() === '') continue;
      if (brakes && !valueIsRedactable(value)) continue;
      if (rule.accept !== undefined && !rule.accept(value)) continue;
      spans.push({ start: group[0], end: group[1], ruleId: rule.ruleId, kind: rule.kind, confidence: rule.confidence });
    }
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end);
};

/** Overlapping spans become one redaction, so a rule that sees a superset does not double-report. */
const mergeSpans = (spans: readonly FakeSpan[]): readonly FakeSpan[] => {
  const merged: FakeSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && span.start < previous.end) {
      merged[merged.length - 1] = {
        ...previous,
        end: Math.max(previous.end, span.end),
      };
      continue;
    }
    merged.push(span);
  }
  return merged;
};

const fakeRedact =
  (rules: readonly FakeRule[], mode: E6RedactionMode, brakes = true) =>
  (text: string): E6RedactionOutcome => {
    const merged = mergeSpans(detectSpans(text, rules, brakes));
    const findings: E6RedactorFinding[] = merged.map((span) => ({
      ruleId: span.ruleId,
      kind: span.kind,
      confidence: span.confidence,
      length: span.end - span.start,
      digest: createHash('sha256').update(text.slice(span.start, span.end)).digest('hex'),
    }));

    // `log` and `off` both leave the text alone. That is the whole difference
    // between them and the reason `control+` is bound separately: a `log` arm
    // gives E6 a false-positive measurement without a rewrite, and reusing `off`
    // would throw that measurement away.
    if (mode === 'off') return { text, changed: false, blocked: false, findings: [] };
    if (mode === 'log') return { text, changed: false, blocked: false, findings };

    let out = '';
    let cursor = 0;
    for (const span of merged) {
      out += text.slice(cursor, span.start) + `[${span.ruleId}]`;
      cursor = span.end;
    }
    out += text.slice(cursor);
    return { text: out, changed: out !== text, blocked: false, findings };
  };

const fakeRedactor = (
  mode: E6RedactionMode,
  overrides: {
    readonly rules?: readonly FakeRule[];
    readonly failOn?: RegExp;
    /** Turns off every value-level brake, which is how the FP report is shown to matter. */
    readonly noValueBrakes?: boolean;
  } = {},
): E6Redactor => {
  const rules = overrides.rules ?? FAKE_RULES;
  const base = fakeRedact(rules, mode, overrides.noValueBrakes !== true);
  return {
    mode,
    redact(text: string): E6RedactionOutcome {
      if (overrides.failOn?.test(text) === true) throw new Error('fake redactor: deliberate failure');
      return base(text);
    },
  };
};

/** The fake redactor with no entropy pass — the mutation that breaks recall. */
const rulesWithoutEntropy = FAKE_RULES.filter((rule) => rule.ruleId !== 'opaque_high_entropy_token');

/** Redacts every identifier of six characters or more. 100% recall, unusable. */
const EATS_IDENTIFIERS: readonly FakeRule[] = [
  {
    ruleId: 'eats_everything',
    kind: 'high_entropy',
    confidence: 'possible',
    pattern: /[A-Za-z_][A-Za-z0-9_]{5,}/g,
    group: 0,
  },
];

const fakeBinding = (id = 'fake-shape-redactor'): E6RedactorBinding =>
  ({
    id,
    productionCodec: false,
    redactors: {
      control: fakeRedactor('off'),
      'control+': fakeRedactor('log'),
      treatment: fakeRedactor('placeholder'),
    },
    // `block` is a mode, not an arm: it refuses to hand anything on, and the
    // fake implements it by reporting its findings and returning nothing.
    blockRedactor: {
      mode: 'block',
      redact(text: string): E6RedactionOutcome {
        const findings = fakeRedact(FAKE_RULES, 'log')(text).findings;
        return { text: '', changed: text !== '', blocked: true, findings };
      },
    },
  }) satisfies E6RedactorBinding;

/** A binding whose block redactor is not in block mode — the assertion cannot run. */
const bindingWithoutBlock = (): E6RedactorBinding => {
  const binding = fakeBinding();
  return { ...binding, blockRedactor: fakeRedactor('log') };
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const field = (insertionPoint: E6InsertionPointName, text: string): E6SinkField => ({ insertionPoint, text });

/**
 * The fake binding with the entropy pass removed.
 *
 * No secret argument: the mutation is to the *rule set*, and a helper that
 * appeared to build a redactor out of a specimen would suggest the specimen
 * reaches it. It does not — which is why the comparison in the test that uses
 * this can hold the specimen fixed and change only the rule.
 */
const withoutEntropyPass = (): E6RedactorBinding => {
  const binding = fakeBinding();
  return {
    ...binding,
    redactors: {
      control: fakeRedactor('off'),
      'control+': fakeRedactor('log'),
      treatment: {
        mode: 'placeholder',
        // Misses exactly the opaque tokens: a redactor with a rule set but no
        // entropy pass, which is the shape of a real gap.
        redact: fakeRedact(rulesWithoutEntropy, 'placeholder'),
      },
    },
  };
};

/**
 * The same writer objects with one name dropped, so the audit can notice.
 *
 * Sharing the objects is the point: a sink that never received a write is only
 * observable to a scan that is handed the sink itself, so the "configuration"
 * and the "wiring" have to be the same six writers minus one, not two sets of six
 * in which the one that was never called has also never been written to.
 */
const miswiredWriters = (
  drop: E6SinkWriter,
  pool: readonly E6SinkWriter[] = createE6ReferenceWriters(),
): readonly E6SinkWriter[] => {
  for (const name of E6_WRITER_NAMES) {
    assert.ok(pool.some((writer) => writer.name === name), `the writer pool should include ${name}`);
  }
  assert.ok(pool.some((writer) => writer.name === drop.name), `the writer pool should include ${drop.name}`);
  return Object.freeze(pool.filter((writer) => writer.name !== drop.name));
};

/**
 * A sink that summarises what it stores, after the fact.
 *
 * Not a strawman: compaction-at-rest is this package's subject, and a writer that
 * receives the secret and does not keep it is a perfectly good product. It is
 * also the case the leak scan has to be honest about — the pipeline graded the
 * bytes it handed over, and the audit grades the bytes that are still there, so
 * the two must be allowed to disagree rather than reconciled by whichever one
 * answers first.
 */
const createCompactingWriter = (name: E6SinkWriter['name']): E6SinkWriter & { compact(span: string): void } => {
  const writes: E6SinkWrite[] = [];
  return {
    name,
    write(write: E6SinkWrite): void {
      writes.push(write);
    },
    written: () => [...writes],
    compact(span: string): void {
      for (let index = 0; index < writes.length; index += 1) {
        const write = writes[index];
        if (write === undefined || !write.content.includes(span)) continue;
        writes[index] = { ...write, content: write.content.split(span).join('[compacted]') };
      }
    },
  };
};

const secretKindsIn = (secrets: readonly E6Secret[]): readonly E6SecretKind[] =>
  [...new Set(secrets.map((secret) => secret.kind))].sort();

const benignWithValue = (value: string, overrides: Partial<E6Benign> = {}): E6Benign => ({
  id: 'e6-benign-synthetic',
  kind: 'ordinary_output',
  value,
  digest: createHash('sha256').update(value).digest('hex'),
  notes: 'synthetic control for a lint test',
  ...overrides,
});

/** Every value the corpus publishes, for the "no secret reached the report" scans. */
const ALL_SECRET_STRINGS = (): readonly string[] =>
  E6_SECRET_CORPUS.flatMap((secret) => [secret.value, secret.secretSpan]);

/**
 * The reportable part of a run, with the fixture left out.
 *
 * The fixture has to be excluded because it is *supposed* to contain the secrets:
 * the prompt plants them. Scanning it would be scanning the thing that plants
 * them, and a suite that "passes" a secrecy scan only because it forgot to look
 * at the one field with the secrets in it has proved nothing. Everything a
 * reader or a CI job would ever see is in here.
 */
const reportable = (result: Awaited<ReturnType<typeof runE6Suite>>): string =>
  JSON.stringify({
    report: result.report,
    gates: result.gates,
    recall: result.recall,
    sinks: result.sinks,
    falsePositives: result.falsePositives,
    block: result.block,
    audit: result.audit,
    recorded: result.recorded,
    corpusIssues: result.corpusIssues,
    provenance: result.provenance,
  });

/* -------------------------------------------------------------------------- */
/* The corpus                                                                  */
/* -------------------------------------------------------------------------- */

describe('e6: the corpus it measures itself against', () => {
  it('lints clean as published', () => {
    assert.deepEqual([...lintE6Corpus()], []);
  });

  it('carries three entries of each of the eight kinds §E6 names', () => {
    assert.deepEqual(secretKindsIn(E6_SECRET_CORPUS), [...E6_SECRET_KINDS].sort());
    assert.equal(E6_SECRET_CORPUS.length, E6_SECRET_KINDS.length * E6_MINIMUM_ENTRIES_PER_SECRET_KIND);
    for (const kind of E6_SECRET_KINDS) {
      const of = E6_SECRET_CORPUS.filter((secret) => secret.kind === kind);
      assert.equal(of.length, E6_MINIMUM_ENTRIES_PER_SECRET_KIND, `${kind} needs three, not ${of.length}`);
      assert.equal(new Set(of.map((secret) => secret.value)).size, of.length, `${kind} repeats a value`);
    }
  });

  it('carries a benign control for every shape entropy scoring loves', () => {
    const kinds = [...new Set(E6_BENIGN_CORPUS.map((entry) => entry.kind))].sort();
    assert.deepEqual(kinds, ['git_sha', 'lockfile_integrity', 'minified_asset', 'ordinary_output', 'sha256_digest']);
    assert.equal(E6_BENIGN_CORPUS.length, 15);
  });

  it('calibrates the entropy floor against both corpora, and records that it does not separate them', () => {
    // `ENTROPY_MINIMUM_BITS`'s comment cites two numbers. Nothing checked them, so
    // a corpus edit could have made the comment a lie without a red test. Measured
    // here instead, over the same tokens the rule actually sees.
    const tokensOf = (text: string): readonly string[] => {
      // A `data:` URI is kept whole rather than shredded on its slashes, because
      // it is one of the highest-entropy benign tokens in the set and splitting it
      // would hide exactly the thing this test is measuring.
      const uris = [...text.matchAll(DATA_URI)].map((match) => match[0]);
      const rest = [...text.replace(DATA_URI, ' ').matchAll(TOKEN_RUN)].map((match) => match[0]);
      return [...uris, ...rest];
    };
    const measurable = (token: string): boolean =>
      token.length >= ENTROPY_MINIMUM_LENGTH && characterClasses(token) >= ENTROPY_MINIMUM_CLASSES;

    const secretTokens = E6_SECRET_CORPUS.filter((secret) => secret.kind === 'high_entropy')
      .flatMap((secret) => tokensOf(secret.value))
      .filter(measurable)
      .map((token) => ({ token, bits: shannonBits(token) }));
    assert.ok(secretTokens.length > 0, 'no high_entropy token cleared the length and class floor');
    const lowestSecret = secretTokens.reduce((lowest, entry) => (entry.bits < lowest.bits ? entry : lowest));
    assert.ok(
      lowestSecret.bits >= ENTROPY_MINIMUM_BITS,
      `the rule's own corpus specimen ${lowestSecret.token.slice(0, 12)}… scores ${lowestSecret.bits.toFixed(2)} bits, ` +
        `under the ${ENTROPY_MINIMUM_BITS} floor, so the recall column rests on a token the rule declines`,
    );

    const benignTokens = E6_BENIGN_CORPUS.flatMap((control) => tokensOf(control.value))
      .filter(measurable)
      .map((token) => ({ token, bits: shannonBits(token), braked: !valueIsRedactable(token) }));
    assert.ok(benignTokens.length > 0, 'no benign token cleared the length and class floor');

    // The finding that justifies the structural brakes, asserted rather than
    // asserted-about: the two corpora overlap on this scale. If this ever becomes
    // false, entropy alone separates them and the brakes are redundant, which is
    // worth knowing.
    const highestBenign = benignTokens.reduce((highest, entry) => (entry.bits > highest.bits ? entry : highest));
    assert.ok(
      highestBenign.bits > lowestSecret.bits,
      `entropy separates the corpora now (benign max ${highestBenign.bits.toFixed(2)} vs secret min ` +
        `${lowestSecret.bits.toFixed(2)}); the structural brakes are no longer load-bearing and can be revisited`,
    );

    // And what the brakes actually buy is measured on the tokens that clear the
    // scale: each one has to be declined somewhere, and the two places are not
    // the same. A `data:` URI scores 4.9 bits, base64 is base64, and
    // `valueIsRedactable` does not decline it — it is blanked by the
    // `minified_asset` pass before any rule is offered the text. Asserting it
    // here rather than adding a `data:` brake to the fake is the point: the
    // architecture already stops it, and a second brake would hide which one.
    const above = benignTokens.filter((entry) => entry.bits >= ENTROPY_MINIMUM_BITS);
    assert.ok(above.length > 0, 'no benign token would have scored high enough for the rule to see it');
    const byValueBrake = above.filter((entry) => entry.braked);
    const byAssetPass = above.filter((entry) => !entry.braked);
    assert.equal(byValueBrake.length + byAssetPass.length, above.length);
    for (const entry of byAssetPass) {
      assert.ok(entry.token.startsWith('data:'), `${entry.token.slice(0, 32)}… is declined by nothing at all`);
    }
    assert.ok(byValueBrake.length > 0, 'the value brakes stopped being load-bearing');
  });

  it('gives every entry a note saying it is inert', () => {
    // §E6 publishes the corpus so other people can run it, and every value here is
    // shaped like a credential. A reader skimming the file has to be able to tell
    // without a decoder which strings are safe to commit.
    for (const secret of E6_SECRET_CORPUS) {
      assert.ok(secret.notes.length > 40, `${secret.id} needs a note, not ${secret.notes.length} characters`);
    }
    for (const control of E6_BENIGN_CORPUS) {
      assert.ok(control.notes.length > 40, `${control.id} needs a note`);
    }
  });

  it('publishes a digest that is sha256 of the value, so a match is confirmable offline', () => {
    for (const secret of E6_SECRET_CORPUS) {
      assert.equal(
        secret.digest,
        createHash('sha256').update(secret.value).digest('hex'),
        `${secret.id}'s digest is not sha256(value)`,
      );
    }
  });

  it('keeps every span above the substring-collision floor', () => {
    for (const secret of E6_SECRET_CORPUS) {
      assert.ok(
        secret.secretSpan.length >= E6_MINIMUM_SECRET_LENGTH,
        `${secret.id}'s span is ${secret.secretSpan.length} characters`,
      );
    }
  });

  it('plants each secret at all seven insertion points, twice over in the tool result', () => {
    for (const secret of E6_SECRET_CORPUS) {
      for (const point of E6_INSERTION_POINT_NAMES) {
        const carrier = renderE6Carrier(point, secret.value);
        assert.ok(carrier.includes(secret.secretSpan), `${secret.id} does not reach ${point}`);
      }
      const occurrences = renderE6Carrier('tool_result', secret.value).split(secret.value).length - 1;
      assert.equal(occurrences, 2, `${secret.id} appears once in the tool result; twice is what catches a redactor that handles one occurrence`);
    }
  });

  describe('and refuses a corpus that would flatter the number', () => {
    const lintCodes = (secrets: readonly E6Secret[], benign: readonly E6Benign[] = E6_BENIGN_CORPUS): readonly string[] =>
      lintE6Corpus(secrets, benign).map((issue) => issue.code);

    it('notices a kind §E6 named that the corpus forgot', () => {
      const without = E6_SECRET_CORPUS.filter((secret) => secret.kind !== 'jwt');
      assert.ok(lintCodes(without).includes('missing_kind'));
    });

    it('notices a kind represented by one string', () => {
      const jwt = E6_SECRET_CORPUS.filter((secret) => secret.kind === 'jwt');
      const without = E6_SECRET_CORPUS.filter((secret) => secret.kind !== 'jwt');
      assert.ok(lintCodes([...without, ...jwt.slice(0, 1)]).includes('under_represented_kind'));
    });

    it('notices a reused id and a reused value', () => {
      const first = E6_SECRET_CORPUS[0];
      const second = E6_SECRET_CORPUS[1];
      assert.ok(first !== undefined && second !== undefined);
      assert.ok(lintCodes([...E6_SECRET_CORPUS, { ...second, value: `${second.value}-cloned` }]).includes('duplicate_id'));
      assert.ok(lintCodes([...E6_SECRET_CORPUS, { ...second, id: 'e6-secret-cloned' }]).includes('duplicate_value'));
    });

    it('notices a digest that does not match its value', () => {
      const first = E6_SECRET_CORPUS[0];
      assert.ok(first !== undefined);
      const tampered = E6_SECRET_CORPUS.map((secret) =>
        secret.id === first.id ? { ...secret, digest: 'f'.repeat(64) } : secret,
      );
      assert.ok(lintCodes(tampered).includes('digest_mismatch'));
    });

    it('notices a span that is not inside its own value', () => {
      const first = E6_SECRET_CORPUS[0];
      assert.ok(first !== undefined);
      const moved = E6_SECRET_CORPUS.map((secret) =>
        secret.id === first.id ? { ...secret, secretSpan: `${first.value}-elsewhere` } : secret,
      );
      assert.ok(lintCodes(moved).includes('span_outside_value'));
    });

    it('notices an empty value, a tiny span, and a missing note', () => {
      const first = E6_SECRET_CORPUS[0];
      assert.ok(first !== undefined);
      // The lint stops at the first problem with an entry rather than piling
      // complaints onto one, so an emptied value and a blank note are two
      // separate mutations. A test that asserted both from one would be asserting
      // a behaviour the lint deliberately does not have.
      const emptied = E6_SECRET_CORPUS.map((secret) =>
        secret.id === first.id ? { ...secret, value: '', secretSpan: '' } : secret,
      );
      assert.ok(lintCodes(emptied).includes('empty_value'));

      const unnoted = E6_SECRET_CORPUS.map((secret) =>
        secret.id === first.id ? { ...secret, notes: '  ' } : secret,
      );
      assert.ok(lintCodes(unnoted).includes('no_notes'));

      const tiny = E6_SECRET_CORPUS.map((secret) =>
        secret.id === first.id ? { ...secret, secretSpan: 'abc', value: 'abc' } : secret,
      );
      assert.ok(lintCodes(tiny).includes('undersized_secret'));
    });

    it('notices a benign control that carries a real secret', () => {
      // The nastiest one: it would *suppress* a leak, because a redactor that
      // catches the secret in the control gets penalised, and a run in which
      // every secret leaked can still show a perfect recall.
      const carrier = E6_SECRET_CORPUS[0];
      assert.ok(carrier !== undefined);
      const contaminated = [
        ...E6_BENIGN_CORPUS,
        benignWithValue(`export STAGING_URL=${carrier.value}`, { id: 'e6-benign-contaminated' }),
      ];
      assert.ok(lintCodes(E6_SECRET_CORPUS, contaminated).includes('benign_carries_secret'));
    });

    it('notices a secret that contains a benign control, which would blur the two counts', () => {
      const control = E6_BENIGN_CORPUS.find((entry) => entry.kind === 'git_sha');
      assert.ok(control !== undefined);
      const blurred = E6_SECRET_CORPUS.map((secret, index) =>
        index === 0 ? { ...secret, value: `prefix${control.value}suffix`, secretSpan: `prefix${control.value}suffix` } : secret,
      );
      assert.ok(lintCodes(blurred).includes('secret_carries_benign'));
    });

    it('notices a benign kind that is missing entirely', () => {
      const withoutShas = E6_BENIGN_CORPUS.filter((entry) => entry.kind !== 'sha256_digest');
      assert.ok(lintCodes(E6_SECRET_CORPUS, withoutShas).includes('missing_benign_kind'));
    });

    it('refuses to build a fixture on top of a corpus it just rejected', () => {
      const without = E6_SECRET_CORPUS.filter((secret) => secret.kind !== 'aws_key');
      assert.throws(
        () => buildE6Fixture(without),
        (error: unknown) => {
          assert.ok(error instanceof E6FixtureError);
          assert.ok(error.issues.some((issue) => issue.code === 'missing_kind'));
          return true;
        },
      );
    });

    it('names the two lint codes the built-in carriers cannot reach, rather than assuming them', () => {
      // `span_not_planted` and `benign_not_planted` compare a carrier against the
      // value it was built from, and all seven carriers embed that value
      // verbatim — so with these carriers the two checks are unreachable. They are
      // the guard for a future carrier that transforms its value (a summarising
      // `file_read`, say), and a test that "covered" them by stubbing a carrier
      // would be testing the stub. Asserted as stated, not as coverage.
      const unreachable = ['span_not_planted', 'benign_not_planted'];
      for (const code of unreachable) {
        assert.equal(
          lintCodes(E6_SECRET_CORPUS).includes(code),
          false,
          `${code} fired on the published corpus`,
        );
      }
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The fixture                                                                 */
/* -------------------------------------------------------------------------- */

/** A mutable copy of the document, for the review-rule mutations. */
const mutableDocument = (): Record<string, unknown> => structuredClone(buildE6Document());

const casesOf = (document: Record<string, unknown>): Record<string, unknown>[] =>
  (document['cases'] ?? []) as Record<string, unknown>[];

describe('e6: a fixture that cannot measure E6 is refused', () => {
  it('builds one case per secret kind, on all three arms, marked negative-control', () => {
    const fixture = buildE6Fixture();
    assert.equal(fixture.cases.length, E6_SECRET_KINDS.length);
    for (const evalCase of fixture.cases) {
      assert.deepEqual([...evalCase.arms].sort(), [...E6_ARMS].sort(), `${evalCase.id} is missing an arm`);
      assert.equal(evalCase.negativeControl, true, `${evalCase.id} stopped being a negative control`);
      assert.equal(evalCase.constraints.length, E6_INSERTION_POINT_NAMES.length);
    }
  });

  it('declares one hard-safety constraint per insertion point, forbidden marker and all', () => {
    const fixture = buildE6Fixture();
    for (const evalCase of fixture.cases) {
      const kind = E6_SECRET_KINDS.find((candidate) => evalCase.id.endsWith(candidate.replace(/_/g, '-')));
      assert.ok(kind !== undefined);
      const secret = E6_SECRET_CORPUS.find((entry) => entry.kind === kind);
      assert.ok(secret !== undefined);
      for (const point of E6_INSERTION_POINT_NAMES) {
        // The two annotations are not decoration. `id` is computed from `kind`,
        // which is only non-`undefined` because of the `assert.ok` above it, and
        // `constraint` is found by comparing candidates against `id` — so each
        // one's inferred type leans on the other's and TypeScript gives up with
        // TS7022 rather than guessing. Both are plain strings.
        const id: string = `e6-${kind}-${point.replace(/_/g, '-')}`;
        const constraint: EvalConstraint | undefined = evalCase.constraints.find(
          (candidate) => candidate.id === id,
        );
        assert.ok(constraint !== undefined, `${evalCase.id} has no constraint for ${point}`);
        assert.equal(constraint.kind, 'hard_safety');
        assert.deepEqual([...constraint.forbidden], [e6LeakMarker(secret.id, point)]);
      }
    }
  });

  it('plants the secret in the prompt without ever printing a marker there', () => {
    // The marker check is not pedantry: the harness grades an arm by searching
    // its response for the forbidden marker, so a marker sitting in the prompt
    // would be found in every arm and every arm would fail for a reason that has
    // nothing to do with redaction.
    const fixture = buildE6Fixture();
    for (const evalCase of fixture.cases) {
      for (const constraint of evalCase.constraints) {
        assert.ok(!evalCase.prompt.includes(constraint.forbidden[0] ?? '\u0000'));
      }
      for (const secret of E6_SECRET_CORPUS) {
        for (const marker of [e6LeakMarker(secret.id, 'tool_result')]) {
          assert.ok(!evalCase.prompt.includes(marker));
        }
      }
    }
  });

  it('offers every carrier to the redactor, so a missing insertion point cannot read as a pass', () => {
    const fixture = buildE6Fixture();
    for (const evalCase of fixture.cases) {
      const kind = E6_SECRET_KINDS.find((candidate) => evalCase.id.endsWith(candidate.replace(/_/g, '-'))) ?? null;
      const secret = E6_SECRET_CORPUS.find((entry) => entry.kind === kind);
      assert.ok(secret !== undefined);
      for (const point of E6_INSERTION_POINT_NAMES) {
        assert.ok(
          evalCase.prompt.includes(renderE6Carrier(point, secret.value)),
          `${evalCase.id} does not offer the ${point} carrier`,
        );
      }
    }
  });

  it('validates clean', () => {
    assert.deepEqual([...validateE6Document(buildE6Document())], []);
  });

  describe('and refuses a document that would', () => {
    const codes = (document: unknown): readonly string[] =>
      validateE6Document(document).map((issue) => issue.code);

    it('drop an arm', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      assert.ok(first !== undefined);
      first['arms'] = ['control', 'treatment'];
      assert.ok(codes(document).includes('missing_arm'));
    });

    it('stop being a negative control', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      assert.ok(first !== undefined);
      first['negativeControl'] = false;
      assert.ok(codes(document).includes('not_negative_control'));
    });

    it('declare only six of the seven insertion points', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      assert.ok(first !== undefined);
      const constraints = (first['constraints'] ?? []) as Record<string, unknown>[];
      first['constraints'] = constraints.slice(1);
      assert.ok(codes(document).includes('missing_insertion_point'));
    });

    it('put a leak marker in the prompt, where the grader would find it in every arm', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      assert.ok(first !== undefined);
      const constraints = (first['constraints'] ?? []) as Record<string, unknown>[];
      const marker = (constraints[0]?.['forbidden'] as string[] | undefined)?.[0];
      assert.ok(marker !== undefined);
      first['prompt'] = `${String(first['prompt'])}\n${marker}`;
      assert.ok(codes(document).includes('marker_in_prompt'));
    });

    it('put a secret value inside a marker, so a report would carry a credential', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      assert.ok(first !== undefined);
      const constraints = (first['constraints'] ?? []) as Record<string, unknown>[];
      const secret = E6_SECRET_CORPUS[0];
      assert.ok(secret !== undefined);
      constraints[0] = { ...constraints[0], forbidden: [`<<leak:${secret.value}>>`] };
      assert.ok(codes(document).includes('marker_in_prompt'));
    });

    it('remove a carrier from the prompt, so the redactor is never asked about it', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      const kind = E6_SECRET_KINDS[0];
      const secret = E6_SECRET_CORPUS.find((entry) => entry.kind === kind);
      assert.ok(first !== undefined && secret !== undefined);
      const carrier = renderE6Carrier('error_trace', secret.value);
      first['prompt'] = String(first['prompt']).replace(carrier, 'the trace was truncated');
      assert.ok(codes(document).includes('prompt_missing_span'));
    });

    it('name a kind it has no corpus entry for', () => {
      const document = mutableDocument();
      const first = casesOf(document)[0];
      assert.ok(first !== undefined);
      first['id'] = 'e6-scope-creep';
      assert.ok(codes(document).includes('prompt_missing_span'));
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The binding                                                                 */
/* -------------------------------------------------------------------------- */

describe('e6: the binding is checked before anything runs', () => {
  it('accepts a well-formed binding', () => {
    assert.doesNotThrow(() => assertE6Binding(fakeBinding()));
  });

  it('refuses an empty id, because a report that cannot name what it measured is not evidence', () => {
    assert.throws(() => assertE6Binding({ ...fakeBinding(), id: '  ' }), E6BindingError);
  });

  it('refuses a missing arm, so no green number can come from forgetting to configure the thing under test', () => {
    const binding = fakeBinding();
    // Rebuilt rather than `delete`d: `redactors` is a total `Record<Arm, …>`, so
    // every key is read-only and removing one is a type error rather than a
    // runtime hole. The point of the case is that a binding which *cannot* name
    // every arm is refused, so the hole has to be forged explicitly — which is
    // what dropping the key out of a `Map` and reading it back does.
    const missingArms = new Map(Object.entries(binding.redactors));
    missingArms.delete('control+');
    const forged = { redactors: Object.fromEntries(missingArms) } as unknown as {
      readonly redactors: Record<Arm, E6Redactor>;
    };
    assert.throws(() => assertE6Binding({ ...binding, ...forged }), (error: unknown) => {
      assert.ok(error instanceof E6BindingError);
      assert.match(error.message, /control\+/);
      return true;
    });
  });

  it('refuses the wrong mode on an arm', () => {
    // The cheapest way to fake a perfect recall: bind the shipping arm to a
    // redactor that is switched off. It is a plausible wiring mistake, not a lie,
    // which is why it is worth a check rather than a convention.
    const binding = fakeBinding();
    assert.throws(
      () => assertE6Binding({ ...binding, redactors: { ...binding.redactors, treatment: fakeRedactor('off') } }),
      (error: unknown) => {
        assert.ok(error instanceof E6BindingError);
        assert.match(error.message, /"placeholder" mode by definition/);
        return true;
      },
    );
  });

  it('refuses a block redactor that is not in block mode', () => {
    assert.throws(() => assertE6Binding(bindingWithoutBlock()), (error: unknown) => {
      assert.ok(error instanceof E6BindingError);
      assert.match(error.message, /block/);
      return true;
    });
  });

  it('refuses to run at all without a binding, rather than defaulting to something green', () => {
    return assert.rejects(
      () => runE6Suite({} as unknown as { readonly binding: E6RedactorBinding }),
      (error: unknown) => {
        assert.ok(error instanceof E6BindingError);
        assert.match(error.message, /injected, not imported/);
        return true;
      },
    );
  });

  it('refuses to run against a mis-bound redactor before it produces a report', async () => {
    const binding = fakeBinding();
    await assert.rejects(
      () => runE6Suite({ binding: { ...binding, redactors: { ...binding.redactors, treatment: fakeRedactor('off') } } }),
      E6BindingError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Applying a redactor                                                         */
/* -------------------------------------------------------------------------- */

describe('e6: applying a redactor to one field', () => {
  const secret = E6_SECRET_CORPUS.find((entry) => entry.kind === 'api_key');
  assert.ok(secret !== undefined);
  const text = renderE6Carrier('tool_result', secret.value);

  it('leaves the bytes alone in "off" mode and reports nothing', () => {
    const applied = applyE6Redaction(fakeRedactor('off'), field('tool_result', text));
    assert.equal(applied.durableText, text);
    assert.equal(applied.forwarded, text);
    assert.equal(applied.blocked, false);
    assert.deepEqual([...applied.findings], []);
  });

  it('reports without rewriting in "log" mode', () => {
    const applied = applyE6Redaction(fakeRedactor('log'), field('tool_result', text));
    assert.equal(applied.durableText, text, 'log must not rewrite; that is what the false-positive rate measures');
    assert.ok(applied.findings.length > 0);
    assert.equal(applied.findings[0]?.kind, 'api_key');
  });

  it('rewrites in "placeholder" mode and leaves no span behind', () => {
    const applied = applyE6Redaction(fakeRedactor('placeholder'), field('tool_result', text));
    assert.ok(applied.durableText !== null);
    assert.ok(!(applied.durableText ?? '').includes(secret.secretSpan));
    assert.ok((applied.durableText ?? '').length < text.length);
  });

  it('redacts both occurrences in a tool result, not just the first', () => {
    const applied = applyE6Redaction(fakeRedactor('placeholder'), field('tool_result', text));
    const placeholders = (applied.durableText ?? '').split('[vendor_prefixed_key]').length - 1;
    assert.equal(placeholders, 2, 'one occurrence redacted is a redactor that handles the first match only');
  });

  it('forwards nothing and refuses the write in "block" mode', () => {
    const applied = applyE6Redaction(
      { mode: 'block', redact: (input) => ({ text: '', changed: input !== '', blocked: true, findings: [] }) },
      field('tool_result', text),
    );
    assert.equal(applied.forwarded, '');
    assert.equal(applied.durableText, null);
    assert.equal(applied.blocked, true);
  });

  it('throws when a redactor claims to block and hands over bytes anyway', () => {
    // The two answers disagree, and they disagree in the direction that leaks.
    // Picking a winner would make the verdict depend on which way the bug goes.
    assert.throws(
      () =>
        applyE6Redaction(
          { mode: 'block', redact: () => ({ text: 'partial', changed: true, blocked: true, findings: [] }) },
          field('tool_result', text),
        ),
      (error: unknown) => {
        assert.ok(error instanceof E6RedactorError);
        assert.equal(error.insertionPoint, 'tool_result');
        assert.match(error.message, /claims both/);
        return true;
      },
    );
  });

  it('fails open for the model and closed for disk when the redactor breaks', () => {
    // Losing a user's context to a redactor bug is catastrophic; writing a
    // credential to a file the user believes is local costs the product's claim.
    const applied = applyE6Redaction(fakeRedactor('placeholder', { failOn: /./ }), field('tool_result', text));
    assert.equal(applied.durableText, null, 'a broken redactor must not decide what is durable');
    assert.equal(applied.forwarded, text, 'a broken redactor must not silently delete the user\'s context');
    assert.ok((applied.redactorError ?? '').length > 0);
  });

  it('refuses a malformed outcome rather than reading fields off undefined', () => {
    assert.throws(
      () =>
        applyE6Redaction(
          { mode: 'placeholder', redact: () => ({ text: 'x', changed: true, blocked: false, findings: null }) as unknown as E6RedactionOutcome },
          field('tool_result', text),
        ),
      E6RedactorError,
    );
  });

  it('keeps the host and database name when it redacts a DSN password', () => {
    // A redaction that removes the reason to rotate the credential is not a
    // better redaction, it is a smaller report.
    const dsn = E6_SECRET_CORPUS.find((entry) => entry.kind === 'connection_string');
    assert.ok(dsn !== undefined);
    const applied = applyE6Redaction(fakeRedactor('placeholder'), field('tool_result', renderE6Carrier('tool_result', dsn.value)));
    const out = applied.durableText ?? '';
    assert.ok(!out.includes(dsn.secretSpan));
    assert.ok(out.includes('db.internal.example'), 'the host is what an operator needs in order to rotate');
    assert.ok(out.includes('billing'), 'the database name too');
  });
});

/* -------------------------------------------------------------------------- */
/* The pipeline                                                                */
/* -------------------------------------------------------------------------- */

const FIXTURE = buildE6Fixture();

/** Corpus entry by id, so a report row can be checked against what it names. */
const SECRET_BY_ID = new Map(E6_SECRET_CORPUS.map((secret) => [secret.id, secret]));

/** The case and the corpus entry for one kind, which is how the fixture is built. */
const caseFor = (kind: E6SecretKind): { readonly evalCase: (typeof FIXTURE)['cases'][number]; readonly secret: E6Secret } => {
  const evalCase = FIXTURE.cases.find((candidate) => candidate.id === `e6-${kind.replace(/_/g, '-')}`);
  const secret = E6_SECRET_CORPUS.find((candidate) => candidate.kind === kind);
  assert.ok(evalCase !== undefined && secret !== undefined, `no case or secret for ${kind}`);
  return { evalCase, secret };
};

describe('e6: the pipeline, one case through every writer', () => {
  it('plants the secret at seven points and offers one benign control alongside', () => {
    const { evalCase, secret } = caseFor('api_key');
    const recorded = runE6Case(evalCase, secret, 'treatment', 0, fakeRedactor('placeholder'), createE6ReferenceWriters());
    assert.equal(recorded.fields.length, E6_INSERTION_POINT_NAMES.length);
    assert.deepEqual(
      recorded.fields.map((entry) => entry.insertionPoint),
      [...E6_INSERTION_POINT_NAMES],
    );
    assert.notEqual(recorded.control, null);
  });

  it('leaks to the model and to every sink when redaction is off', () => {
    const { evalCase, secret } = caseFor('api_key');
    const writers = createE6ReferenceWriters();
    const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), writers);
    for (const entry of recorded.fields) {
      assert.equal(entry.leakedToModel, true, `${entry.insertionPoint} did not reach the model`);
      assert.deepEqual([...entry.leakedToWriters], [...E6_WRITER_NAMES].sort(), `${entry.insertionPoint} missed a sink`);
      assert.equal(entry.contained, false);
    }
    assert.equal(recorded.violatedConstraintIds.length, E6_INSERTION_POINT_NAMES.length);
    assert.equal(recorded.writeRefused, false);
  });

  it('contains everything in the shipping arm', () => {
    const { evalCase, secret } = caseFor('api_key');
    const writers = createE6ReferenceWriters();
    const recorded = runE6Case(evalCase, secret, 'treatment', 0, fakeRedactor('placeholder'), writers);
    for (const entry of recorded.fields) {
      assert.equal(entry.contained, true, `${entry.insertionPoint} leaked`);
      assert.equal(entry.leakedToModel, false);
      assert.deepEqual([...entry.leakedToWriters], []);
    }
    assert.deepEqual([...recorded.violatedConstraintIds], []);
  });

  it('reports nothing in the log arm either, because log rewrites nothing and so leaks everything', () => {
    // `control+` exists to be a second negative control *and* the false-positive
    // probe. A run in which it came back clean would mean the leak detector had
    // stopped working, not that the mode was safe.
    const { evalCase, secret } = caseFor('api_key');
    const writers = createE6ReferenceWriters();
    const recorded = runE6Case(evalCase, secret, 'control+', 0, fakeRedactor('log'), writers);
    assert.equal(recorded.fields.every((entry) => entry.contained), false);
    assert.equal(recorded.fields.every((entry) => entry.leakedToWriters.length === E6_WRITER_NAMES.length), true);
  });

  it('writes to all six writers, across all four §E6 sink categories', () => {
    const { evalCase, secret } = caseFor('api_key');
    const writers = createE6ReferenceWriters();
    const recorded = runE6Case(evalCase, secret, 'treatment', 0, fakeRedactor('placeholder'), writers);
    assert.deepEqual([...recorded.writersWritten], [...E6_WRITER_NAMES].sort());
    const categories = new Set(writers.map((writer) => E6_WRITER_CATEGORIES[writer.name]));
    assert.deepEqual([...categories].sort(), [...E6_SINK_CATEGORIES].sort());
    // Telemetry is bound as three concrete writers, which is the point: one
    // "telemetry" name in a report cannot be checked, three can.
    assert.equal(writers.filter((writer) => E6_WRITER_CATEGORIES[writer.name] === 'telemetry').length, 3);
  });

  it('actually fans the tee out to both leaves', () => {
    const { evalCase, secret } = caseFor('api_key');
    const leaf = createE6ReferenceWriters().find((writer) => writer.name === 'telemetry.jsonl');
    assert.ok(leaf !== undefined);
    const tee = createE6TeeWriter('telemetry.tee', [leaf]);
    runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), [tee]);
    assert.equal(tee.written().length, 1);
    assert.equal(leaf.written().length, 1, 'a tee that keeps nothing is not a fan-out');
    assert.equal(leaf.written()[0]?.content, tee.written()[0]?.content);
  });

  it('refuses a tee with no leaves', () => {
    const { evalCase, secret } = caseFor('api_key');
    assert.throws(
      () => runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), [createE6TeeWriter('telemetry.tee', [])]),
      /fan-out/,
    );
  });

  it('attributes a write to the run that caused it, not to everything that came before', () => {
    // The writers are long-lived and the same six serve all three arms. Grading a
    // leak by scanning their whole history would mean the control arm's
    // deliberate leaks were still sitting in the log when the treatment arm was
    // graded, and every sink would be reported as leaking in the arm that
    // redacted. Two cases in a row, one arm each, is the test.
    const writers = createE6ReferenceWriters();
    const off = caseFor('api_key');
    const bearer = caseFor('bearer_token');
    runE6Case(off.evalCase, off.secret, 'control', 0, fakeRedactor('off'), writers);
    const redacted = runE6Case(bearer.evalCase, bearer.secret, 'treatment', 1, fakeRedactor('placeholder'), writers);
    assert.equal(redacted.fields.every((entry) => entry.contained), true);
    assert.equal(
      redacted.fields.every((entry) => entry.leakedToWriters.length === 0),
      true,
      "the earlier arm's leaks were counted against the redacted arm",
    );
    assert.deepEqual([...redacted.writersWritten], [...E6_WRITER_NAMES].sort());
  });

  it('carries one benign control through the same write, so a pass is not a blank', () => {
    const { evalCase, secret } = caseFor('api_key');
    const recorded = runE6Case(evalCase, secret, 'treatment', 0, fakeRedactor('placeholder'), createE6ReferenceWriters());
    const control = recorded.control;
    assert.ok(control !== null);
    assert.ok((control?.forwardedBytes ?? 0) > 0, 'the control was withheld, so the case proves nothing about redaction');
    assert.equal(control?.blocked, false);
    assert.equal(control?.rewritten, false, 'the fake rewrote a benign control');
  });

  it('grades the secret at a shared insertion point on its own outcome, not the control beside it', () => {
    // Both fields are `tool_result`. An implementation that keyed outcomes on the
    // insertion point would read the control's result for the secret, and since
    // the control carries no secret, the secret's `tool_result` would come back
    // "contained" in the arm whose entire job is to leak.
    const { evalCase, secret } = caseFor('api_key');
    const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), createE6ReferenceWriters());
    const toolResult = recorded.fields.find((entry) => entry.insertionPoint === 'tool_result');
    assert.equal(toolResult?.leakedToModel, true);
    assert.equal(toolResult?.leakedToWriters.length, E6_WRITER_NAMES.length);
  });

  it('writes a response made of markers, not of secrets', () => {
    const { evalCase, secret } = caseFor('api_key');
    const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), createE6ReferenceWriters());
    assert.equal(recorded.response.includes(secret.value), false);
    assert.equal(recorded.response.includes(secret.secretSpan), false);
    for (const entry of recorded.fields) {
      assert.ok(recorded.response.includes(e6LeakMarker(secret.id, entry.insertionPoint)));
    }
  });

  it('names the destinations, because "a leak occurred" is not a finding', () => {
    const { evalCase, secret } = caseFor('api_key');
    const gistOnly = createE6ReferenceWriters().filter((writer) => writer.name === 'gist');
    const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), gistOnly);
    assert.match(recorded.response, /\bin model, gist\b/);
    assert.equal(recorded.response.includes('artifact_store'), false);
  });

  /* ---------------------------------------------------------------- */
  /* The four sink categories, graded on the bytes they actually kept    */
  /* ---------------------------------------------------------------- */

  it('puts the planted secret in the serialized bytes of all four sink categories', () => {
    // The point of the category split is that a redaction has to survive four
    // different serialisations, so the assertion is made against
    // `renderE6WriteContent` output rather than against the in-memory field: a
    // writer that receives a secret and stores a gist of it has not leaked it,
    // and only the stored bytes can tell the two apart.
    const { secret } = caseFor('api_key');
    const fields = buildE6CaseFields(secret);
    assert.deepEqual([...E6_SINK_CATEGORIES], ['gist', 'artifact_store', 'telemetry', 'ctx_status']);
    for (const category of E6_SINK_CATEGORIES) {
      const content = renderE6WriteContent(category, fields);
      assert.ok(
        e6StoredBytesHold(content, secret.secretSpan),
        `${category} serialised the session without the secret, so the carrier never reached it`,
      );
      // The raw spelling too, for a single-line value: JSON escaping only bites
      // on newlines and quotes, and this secret has neither.
      assert.ok(content.includes(secret.secretSpan), `${category} did not store the span literally`);
      assert.ok(!content.includes(secret.value) === false, `${category} stored the whole carrier value`);
    }
    // The four are four formats, not four names for one blob, and each is
    // distinguishable in the bytes.
    const rendered = E6_SINK_CATEGORIES.map((category) => renderE6WriteContent(category, fields));
    assert.equal(new Set(rendered).size, E6_SINK_CATEGORIES.length, 'two categories serialise identically');
    assert.ok(rendered[0]?.startsWith('# session capture'), 'gist is markdown');
    assert.ok(rendered[2]?.trimStart().startsWith('{"event"'), 'telemetry is JSONL');
    assert.ok(rendered[3]?.startsWith('tool_result:'), 'ctx_status is key/value lines');
  });

  it('finds a JSON-escaped private key in the sinks that re-encode newlines', () => {
    // The regression this pins: `artifact_store` and all three `telemetry`
    // writers are handed a JSON document, and `JSON.stringify` writes a newline
    // as `\` `n`. A PEM block is therefore present in those sinks in full while a
    // literal `content.includes(span)` says it is absent — a sink graded clean
    // for holding, verbatim, the secret it re-encoded.
    const { secret } = caseFor('private_key');
    assert.ok(secret.secretSpan.includes('\n'), 'the private_key specimen must be multi-line for this to mean anything');
    const fields = buildE6CaseFields(secret);
    const escaped = JSON.stringify(secret.secretSpan).slice(1, -1);
    assert.notEqual(escaped, secret.secretSpan);
    for (const category of E6_SINK_CATEGORIES) {
      const content = renderE6WriteContent(category, fields);
      const literal = content.includes(secret.secretSpan);
      assert.equal(e6StoredBytesHold(content, secret.secretSpan), true, `${category} reported a held PEM as absent`);
      assert.equal(literal, category === 'gist' || category === 'ctx_status', `${category} literal/JSON form`);
      if (category === 'artifact_store' || category === 'telemetry') {
        assert.ok(content.includes(escaped), `${category} should hold the secret only in escaped form`);
      }
    }
  });

  it('records every writer as a destination for the secret when redaction is off', () => {
    // All six, for all seven insertion points, for both a single-line and a
    // multi-line specimen. `leakedToWriters` is the report's own claim, so this
    // is where it is checked against the bytes rather than trusted.
    for (const kind of ['api_key', 'private_key'] as const) {
      const { evalCase, secret } = caseFor(kind);
      const writers = createE6ReferenceWriters();
      const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), writers);
      for (const entry of recorded.fields) {
        assert.deepEqual(
          [...entry.leakedToWriters],
          [...E6_WRITER_NAMES].sort(),
          `${kind}/${entry.insertionPoint} missed a sink`,
        );
        for (const writer of writers) {
          const stored = writer.written().filter((write) => write.runId === recorded.runId);
          // The two recording telemetry writers take a second copy through the
          // tee, which is the point of a tee: the bytes land in both.
          assert.ok(stored.length >= 1, `${writer.name} took no write for this run`);
          for (const write of stored) {
            assert.ok(
              e6StoredBytesHold(write.content, secret.secretSpan),
              `${writer.name} is listed as holding the secret but its bytes do not`,
            );
            assert.equal(write.runId, recorded.runId);
            assert.equal(write.category, E6_WRITER_CATEGORIES[writer.name]);
            // Attribution names a real sink and no other. Which of the two is not
            // asserted: `telemetry.tee.written()` is deliberately the *union* of
            // its leaves' contents, so it also surfaces the copy each leaf was
            // handed directly, stamped with that leaf's name.
            assert.ok(
              (E6_WRITER_NAMES as readonly string[]).includes(write.writer),
              `${writer.name} holds a write attributed to ${write.writer}`,
            );
          }
        }
      }
    }
  });

  it('summarises each sink from what it kept, and names a silent one', () => {
    const { evalCase, secret } = caseFor('api_key');
    const writers = createE6ReferenceWriters();
    const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), writers);
    const summaries = summariseE6Sinks([recorded], writers);
    assert.deepEqual([...summaries.map((entry) => entry.writer)].sort(), [...E6_WRITER_NAMES].sort());
    for (const summary of summaries) {
      assert.equal(summary.category, E6_WRITER_CATEGORIES[summary.writer]);
      assert.ok(summary.writes >= 1, `${summary.writer} has no write behind its summary`);
      assert.equal(summary.fieldsLeaked, E6_INSERTION_POINT_NAMES.length, `${summary.writer} leaked ${summary.fieldsLeaked}`);
      assert.equal(summary.leakMarkers.length, E6_INSERTION_POINT_NAMES.length);
      for (const marker of summary.leakMarkers) {
        assert.ok(e6AllLeakMarkers().includes(marker), `${summary.writer} invented the marker ${marker}`);
        assert.ok(!marker.includes(secret.value), `${summary.writer} marker carries the secret value`);
        assert.ok(!marker.includes(secret.secretSpan), `${summary.writer} marker carries the secret span`);
      }
    }
  });

  it('notices a writer wired to nothing, rather than scoring it as a clean sink', () => {
    // Zero leaks from a sink that never ran is the most flattering number in the
    // report, so the audit has to name it. `configured` is the wiring as shipped —
    // six sinks — and the run below reaches five of them, so the audit is handed
    // the configuration and asked which of the six it never heard from.
    const { evalCase, secret } = caseFor('api_key');
    const healthy = createE6ReferenceWriters();
    const wired = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), healthy);
    assert.deepEqual([...auditE6Run([wired], healthy).silentWriters], []);
    assert.deepEqual([...auditE6Run([wired], healthy).disagreements], []);

    // A fresh pool, because "silent" means this configuration's sink took no
    // write, and a gist that was handed a write by the run above is not silent.
    const configured = createE6ReferenceWriters();
    const gist = configured.find((writer) => writer.name === 'gist');
    assert.ok(gist !== undefined, 'the reference writers should include gist');
    const partial = miswiredWriters(gist, configured);
    assert.equal(partial.length, E6_WRITER_NAMES.length - 1);
    const run = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), partial);
    assert.equal(run.fields.every((entry) => !entry.leakedToWriters.includes('gist')), true);
    assert.equal(run.fields.every((entry) => entry.contained === false), true, 'the other five still hold it');

    const afterWiring = auditE6Run([run], configured);
    assert.deepEqual([...afterWiring.silentWriters], ['gist'], 'a sink that was never handed a write is not a clean sink');
    assert.deepEqual(
      [...afterWiring.disagreements],
      [],
      'a sink that never ran is a wiring fault, not a disagreement about what it holds',
    );
    // And it is visible in the sink summary, so it is not only the audit's news.
    const summary = summariseE6Sinks([run], configured).find((entry) => entry.writer === 'gist');
    assert.equal(summary?.writes, 0);
    assert.equal(summary?.fieldsLeaked, 0);
    assert.deepEqual([...summary?.leakMarkers ?? []], []);
  });

  it('lets a sink compact after the fact and records the disagreement rather than reconciling it', () => {
    // A sink that receives the secret and does not keep it is a perfectly good
    // product. The audit grades the bytes that are still there, so it must be
    // allowed to disagree with what the pipeline saw.
    const { evalCase, secret } = caseFor('api_key');
    const gist = createCompactingWriter('gist');
    const writers: readonly E6SinkWriter[] = [gist];
    const recorded = runE6Case(evalCase, secret, 'control', 0, fakeRedactor('off'), writers);
    const before = auditE6Run([recorded], writers);
    assert.deepEqual([...before.disagreements], [], 'before compaction the two agree');
    assert.deepEqual([...before.silentWriters], []);

    gist.compact(secret.secretSpan);
    const after = auditE6Run([recorded], writers);
    assert.equal(after.disagreements.length, E6_INSERTION_POINT_NAMES.length, 'every field now disagrees');
    for (const line of after.disagreements) {
      assert.match(line, /the pipeline said \[gist\]/);
      assert.match(line, /the writers' stored bytes say \[none\]/);
    }
    assert.deepEqual([...after.silentWriters], [], 'a sink that stored and then compacted is not silent');
  });
});

/* -------------------------------------------------------------------------- */
/* Block mode                                                                  */
/* -------------------------------------------------------------------------- */

describe('e6: block mode, which is an assertion rather than a configuration', () => {
  it('refuses to run without a redactor in block mode', () => {
    assert.throws(() => runE6BlockProbe(FIXTURE, E6_SECRET_CORPUS, bindingWithoutBlock()), (error: unknown) => {
      assert.ok(error instanceof E6BindingError);
      assert.match(error.message, /cannot falsify/);
      return true;
    });
  });

  it('blocks all 168 planted secrets, forwards nothing, and leaks nothing', () => {
    const probe = runE6BlockProbe(FIXTURE, E6_SECRET_CORPUS, fakeBinding());
    assert.equal(probe.redactorMode, 'block');
    assert.equal(probe.observations, E6_SECRET_CORPUS.length * E6_INSERTION_POINT_NAMES.length);
    assert.equal(probe.blocked, probe.observations);
    assert.equal(probe.forwardedNothing, probe.observations);
    assert.equal(probe.leaks, 0);
    assert.deepEqual([...probe.offenders], []);
  });

  it('refuses the whole write, not just the field that was blocked', () => {
    // A gist with the credential line removed and the rest intact is still a gist
    // that says a credential was here. And a telemetry line missing a field no
    // longer matches the readers downstream of it.
    const writers = createE6ReferenceWriters();
    const probe = runE6BlockProbe(FIXTURE, E6_SECRET_CORPUS, fakeBinding(), writers);
    assert.equal(probe.writesRefused, E6_SECRET_CORPUS.length);
    assert.deepEqual([...writers.flatMap((writer) => writer.written())], []);
  });

  it('accounts for every benign control, so a pass was not bought by forwarding nothing', () => {
    // A `block`-mode redactor refuses the whole tool result, so the benign line
    // inside it is blocked too — that is the normal outcome, not a failure.
    // What must never happen is a control that is neither blocked nor forwarded,
    // because then the numbers above it are being read off a run where data
    // disappeared for an unstated reason. The non-vacuity check that *does*
    // matter — that a pass is not "forwarded nothing" — is made against the
    // shipping arm above, where the control has to arrive.
    const probe = runE6BlockProbe(FIXTURE, E6_SECRET_CORPUS, fakeBinding());
    assert.equal(probe.controls, E6_SECRET_CORPUS.length);
    assert.equal(probe.controlsBlocked + probe.controlsForwarded, probe.controls);
    assert.equal(probe.controlsBlocked, E6_SECRET_CORPUS.length);
    assert.equal(probe.complete, true);
  });

  it('reports an incomplete probe rather than passing it', () => {
    const blocksNothing: E6RedactorBinding = {
      ...fakeBinding(),
      blockRedactor: { mode: 'block', redact: (input) => ({ text: '', changed: input !== '', blocked: false, findings: [] }) },
    };
    const probe = runE6BlockProbe(FIXTURE, E6_SECRET_CORPUS, blocksNothing);
    assert.equal(probe.blocked, 0);
    assert.equal(probe.complete, false);
    assert.equal(probe.offenders.length, probe.observations);
  });
});


/* -------------------------------------------------------------------------- */
/* The three arms and the number G9 is read on                                */
/* -------------------------------------------------------------------------- */

/** One run of the suite, shared by the assertions below. */
const RUN = await runE6Suite({ binding: fakeBinding(), seed: 20260930 });

describe('e6: three arms, and the one the gate reads', () => {
  it('binds each arm to the mode that arm is defined as', () => {
    assert.deepEqual(E6_ARM_MODES, { control: 'off', 'control+': 'log', treatment: 'placeholder' });
  });

  it('reports the shipping arm at full recall and both negative controls at zero', () => {
    const byArm = new Map(RUN.recall.map((summary) => [summary.arm, summary]));
    assert.equal(byArm.get('treatment')?.recall, 1);
    assert.equal(byArm.get('treatment')?.secretsContained, E6_SECRET_CORPUS.length);
    assert.equal(byArm.get('control')?.recall, 0);
    assert.equal(byArm.get(NEGATIVE_CONTROL_ARM_LABEL)?.recall, 0);
  });

  it('counts one observation per secret per insertion point, per arm', () => {
    const expected = E6_SECRET_CORPUS.length * E6_INSERTION_POINT_NAMES.length;
    for (const summary of RUN.recall) {
      assert.equal(summary.observations, expected, `${summary.arm} counted ${summary.observations} observations`);
      assert.equal(summary.secrets, E6_SECRET_CORPUS.length);
    }
    assert.ok(expected > E6_RECALL_OBSERVATION_TARGET);
    assert.equal(E6_RECALL_OBSERVATION_TARGET, 73);
  });

  it('cannot see a leak if its negative control does not leak, so both are asserted every run', () => {
    // The negative controls are the suite's own smoke alarm. A control that came
    // back clean would mean the detector stopped working, and every containment
    // number in the report would then be a statement about nothing.
    const control = RUN.recorded.filter((record) => record.arm === 'control');
    // One record per *(case, corpus specimen)*, not one per case: a case plants
    // every specimen of its kind, so eight cases carry twenty-four specimens and
    // `observations` in the recall summary is 24 x 7, not 8 x 7. Asserting the
    // case count here would have quietly accepted a suite that planted one
    // specimen per kind and measured 56 of the 168 observations it claims.
    assert.equal(
      control.length,
      FIXTURE.cases.length * E6_MINIMUM_ENTRIES_PER_SECRET_KIND,
    );
    for (const record of control) {
      assert.equal(record.fields.length, E6_INSERTION_POINT_NAMES.length);
      assert.equal(record.fields.every((entry) => entry.leakedToWriters.length === E6_WRITER_NAMES.length), true);
    }
    const controlPlus = RUN.recorded.filter((record) => record.arm === NEGATIVE_CONTROL_ARM_LABEL);
    assert.equal(controlPlus.length, control.length);
    assert.equal(
      controlPlus.every((record) => record.fields.every((entry) => entry.leakedToWriters.length === E6_WRITER_NAMES.length)),
      true,
      'the log arm rewrites nothing, so it leaks to every writer in every field',
    );
  });

  it('retains every constraint and drops none, because a leak is a violation, not a retention failure', () => {
    // Conflating the two would make the report say "the stage forgot the field"
    // when what happened is that the field survived.
    //
    // `RunReport` is the frozen shared type (F1-1) and has no `observations`
    // array: the per-(case, arm) pair is the join of `cases[]` and
    // `cases[].arms[]`, and the constraint count lives on the *case* while
    // retention lives on the *arm*. Reading the real fields rather than a richer
    // local shape is the point — a suite that asserted against its own idea of
    // the report would still be green if the shared type stopped carrying the
    // evidence.
    const observations = RUN.report.cases.flatMap((result) =>
      result.arms.map((arm) => ({ caseId: result.caseId, arm: arm.arm, result, observation: arm })),
    );
    assert.equal(observations.length, RUN.report.totals.observations);
    assert.equal(observations.length, FIXTURE.cases.length * E6_ARMS.length);
    for (const { caseId, observation } of observations) {
      assert.deepEqual([...observation.droppedConstraintIds], [], `${caseId}/${observation.arm} dropped one`);
      const caseResult = RUN.report.cases.find((result) => result.caseId === caseId);
      assert.ok(caseResult !== undefined);
      assert.equal(observation.retainedConstraintIds.length, caseResult.constraintCount);
    }
  });

  it('reports every leak as a violation and every case as a violation in the controls', () => {
    // The other half of the assertion above, and the reason the two are separate:
    // in the negative controls every constraint is *retained* and every one is
    // *violated*, because a leak is the prohibited effect appearing and not the
    // field being dropped.
    //
    // The markers come off the case, not off a record. `buildE6Document` bakes
    // one specimen per kind into `constraints[].forbidden`, so the violation list
    // names that specimen while `runE6Suite` plants all three — which is why
    // this walks cases and arms and joins the markers back to the corpus rather
    // than to `RUN.recorded`. It is also the honest limit of the report, stated
    // here rather than papered over: `observations` counts 24 specimens x 7
    // points per arm, but the violation list names 8 specimens' worth of markers,
    // so `totals.violations` undercounts the off arm's leaks by a factor of
    // three. Containment is measured per record and is unaffected; the marker
    // list is a per-case summary, not a per-specimen ledger.
    const cases = new Set(RUN.recorded.filter((record) => record.arm === 'treatment').map((record) => record.caseId));
    assert.equal(cases.size, FIXTURE.cases.length);
    for (const result of RUN.report.cases) {
      const fixtureCase = FIXTURE.cases.find((candidate) => candidate.id === result.caseId);
      assert.ok(fixtureCase !== undefined, `no fixture case for ${result.caseId}`);
      const forbidden = fixtureCase.constraints.flatMap((constraint) => constraint.forbidden);
      for (const arm of result.arms) {
        const where = `${arm.arm}/${result.caseId}`;
        if (arm.arm === 'treatment') {
          assert.deepEqual([...arm.violations], [], `${where} redacted everything, so nothing was violated`);
          continue;
        }
        assert.equal(arm.violations.length, E6_INSERTION_POINT_NAMES.length, `${where} must leak at every insertion point`);
        assert.deepEqual(
          arm.violations.map((violation) => violation.marker).sort(),
          [...forbidden].sort(),
          `${where} must name every leaked field`,
        );
        for (const violation of arm.violations) {
          assert.equal(violation.kind, 'hard_safety', `${where} must score a leak as hard safety`);
          // A marker that quotes the secret turns the report into a second copy
          // of the leak. `e6LeakMarker` carries the secret *id* and the insertion
          // point, and the id is what makes the row joinable to the corpus.
          const named = /^<<leak:(?<secretId>[^:]+):(?<point>[a-z_]+)>>$/.exec(violation.marker);
          assert.ok(named !== null, `${where} marker is not in leak-marker form: ${violation.marker}`);
          const secretId = named.groups?.['secretId'] ?? '';
          const point = named.groups?.['point'] ?? '';
          const secret = SECRET_BY_ID.get(secretId);
          assert.ok(secret !== undefined, `${where} names a secret outside the corpus: ${secretId}`);
          assert.ok(
            (E6_INSERTION_POINT_NAMES as readonly string[]).includes(point),
            `${where} marker names an insertion point the suite does not plant: ${point}`,
          );
          assert.ok(!violation.marker.includes(secret.value), `${where} marker quotes the secret value`);
          assert.ok(!violation.marker.includes(secret.secretSpan), `${where} marker quotes the secret span`);
        }
      }
    }
  });

  it('reports no false retention failure in either negative control', () => {
    // `RunReport.negativeControls` is the shared type's own list of
    // `NegativeControlSummary`; there is no `sections.negativeControl` counter to
    // read, and inventing one would have made this a test of the invention.
    const controls = RUN.report.negativeControls;
    assert.equal(controls.length, FIXTURE.cases.length, 'every E6 case is a negative control');
    assert.ok(controls.length > 0);
    assert.equal(
      controls.filter((summary) => !summary.fired).length,
      0,
      'a negative control that did not fail is a broken leak detector',
    );
    for (const summary of controls) {
      assert.deepEqual([...summary.failingArms].sort(), ['control', 'control+']);
    }
    assert.equal(RUN.report.totals.negativeControls, FIXTURE.cases.length);
    assert.equal(RUN.report.totals.negativeControlsFired, FIXTURE.cases.length);
  });

  it('orders the run so the arms are interleaved, and says so from the harness', () => {
    const arms = RUN.report.executionOrder.map((step) => step.arm);
    assert.equal(arms.length, FIXTURE.cases.length * E6_ARMS.length);
    assert.equal(new Set(arms).size, E6_ARMS.length, 'all three arms ran');
    const firstThree = arms.slice(0, E6_ARMS.length);
    assert.equal(new Set(firstThree).size, E6_ARMS.length, 'the first three steps are not one of each arm');
  });

  it('derives the recall column from the recorded fields, so the two cannot drift', () => {
    // `RUN.recall` is produced by `summariseE6Recall` inside the suite, and the
    // gate is read off it. Re-deriving it here from `RUN.recorded` is the check
    // that the number G9 is read on is a function of the evidence rather than a
    // figure the suite asserts about itself.
    const derived = summariseE6Recall(RUN.recorded);
    assert.deepEqual(derived, [...RUN.recall]);
    for (const arm of E6_ARMS) {
      const summary: E6ArmSummary | undefined = derived.find((entry) => entry.arm === arm);
      assert.ok(summary !== undefined, `no recall summary for ${arm}`);
      const fields = RUN.recorded.filter((record) => record.arm === arm).flatMap((record) => record.fields);
      assert.equal(summary.observations, fields.length);
      assert.equal(summary.observations, E6_SECRET_CORPUS.length * E6_INSERTION_POINT_NAMES.length);
      assert.equal(
        summary.contained,
        fields.filter((entry) => entry.contained).length,
        `${arm}: contained count is not the count of contained fields`,
      );
      assert.equal(
        summary.secretsContained,
        fields.filter((entry) => entry.contained).length / E6_INSERTION_POINT_NAMES.length,
        `${arm}: a secret counted as contained had one of its seven points leak`,
      );
      assert.equal(summary.secrets, E6_SECRET_CORPUS.length);
      // The denominator is every specimen at every point, so a specimen nobody
      // planted shows up as a recall number below 1 rather than a smaller sample.
      assert.equal(summary.recall, arm === 'treatment' ? 1 : 0);
      // Wilson brackets the point estimate. A saturated arm has a lower bound
      // *below* 1 — that gap is the reason the gate carries a confidence floor
      // and a point threshold rather than pretending 168/168 is certainty.
      assert.ok(summary.ciLower <= (summary.recall ?? 0), `${arm}: ciLower is above the point estimate`);
      assert.ok((summary.recall ?? 0) <= summary.ciUpper, `${arm}: the point estimate is above ciUpper`);
      assert.ok(summary.ciLower < G9_RECALL_THRESHOLD, `${arm}: a finite n cannot reach 1.0 with a lower bound`);
    }
  });

  it('scores a redactor with a rule set but no entropy pass below 100%, which is what G9 is for', () => {
    // The mutation: this is the fake with its entropy rule removed and
    // nothing else changed. The opaque-token specimens are the only kind that
    // needs it, so recall must drop below the gate — and it must drop because of
    // those specimens specifically, not everywhere.
    const highEntropy = E6_SECRET_CORPUS.filter((secret) => secret.kind === 'high_entropy');
    assert.ok(highEntropy.length > 0, 'the corpus has no high_entropy specimen to miss');
    const binding = withoutEntropyPass();
    assert.equal(binding.redactors.treatment.mode, 'placeholder');
    const writers = createE6ReferenceWriters();
    const handle = createE6ArmRunner(FIXTURE, E6_SECRET_CORPUS, binding, writers);
    assert.deepEqual([...handle.writers.map((writer) => writer.name)].sort(), [...E6_WRITER_NAMES].sort());

    // Driven through the harness's own `ArmInvocation`, which is the shape F2
    // will call: the runner is an adapter, not an entry point, so it is exercised
    // the way `runSuite` exercises it rather than by a call of its own design.
    const highEntropyCase = FIXTURE.cases.find((candidate) => candidate.id === 'e6-high-entropy');
    assert.ok(highEntropyCase !== undefined, 'the fixture has no high_entropy case');
    const invocation: Parameters<typeof handle.run>[0] = {
      harnessSeed: 20260930,
      suite: E6_SUITE_ID,
      case: highEntropyCase,
      arm: 'treatment',
      position: 0,
      attempt: 1,
    };
    const observation = handle.run(invocation);
    assert.equal(observation.arm, 'treatment');
    assert.equal(observation.ok, true);
    assert.equal(observation.error, null);
    // E6 makes no model call, so the token columns are measured text sizes and
    // the latency is zero — a number with no instrument behind it is not invented.
    assert.ok(observation.inputTokens > 0);
    assert.ok(observation.outputTokens > 0);
    assert.equal(observation.latencyMs, 0);

    const recorded = handle.recorded();
    assert.equal(recorded.length, E6_MINIMUM_ENTRIES_PER_SECRET_KIND, 'one record per specimen of the kind');
    const summaries = summariseE6Recall(recorded);
    const treatment = summaries.find((entry) => entry.arm === 'treatment');
    assert.ok(treatment !== undefined);
    assert.ok((treatment.recall ?? 0) < 1, `a redactor with no entropy pass scored ${String(treatment.recall)}`);
    assert.equal(treatment.observations, E6_MINIMUM_ENTRIES_PER_SECRET_KIND * E6_INSERTION_POINT_NAMES.length);
    assert.deepEqual([...new Set(recorded.map((record) => record.fields[0]?.secretKind))], ['high_entropy']);
    for (const record of recorded) {
      assert.equal(record.fields.some((entry) => entry.contained === false), true, `${record.secretId} was contained anyway`);
    }
    // Same invocation, same case, the unmutated binding: the only difference is
    // the removed rule, so the recall difference is attributable to it.
    const intact = createE6ArmRunner(FIXTURE, E6_SECRET_CORPUS, fakeBinding(), createE6ReferenceWriters());
    intact.run(invocation);
    const intactSummary = summariseE6Recall(intact.recorded()).find((entry) => entry.arm === 'treatment');
    assert.equal(intactSummary?.recall, 1);
    assert.equal(treatment.recall, 0, 'the opaque tokens are the only thing the entropy pass catches');

    // The gate is read on this number, so assert the gate moves rather than
    // leaving the reader to work it out.
    const recallGate = evaluateE6Gates(summaries, binding).find((gate) => gate.arm === 'treatment');
    assert.ok(recallGate !== undefined);
    assert.equal(recallGate.status, 'not_observed');
    assert.equal(recallGate.recall, treatment.recall);
    assert.equal(recallGate.threshold, G9_RECALL_THRESHOLD);
  });

  it('publishes a report with no secret in it, which is the only safe artefact', () => {
    // Everything a reader or a CI job would see, stringified and scanned. The
    // fixture is deliberately not in the scan — it is supposed to contain the
    // secrets, because it is the thing that plants them.
    const report = reportable(RUN);
    assert.ok(report.length > 0);
    for (const value of ALL_SECRET_STRINGS()) {
      assert.ok(!report.includes(value), `the report carries a corpus secret verbatim: ${value.slice(0, 12)}…`);
    }
    // Digests are the one derived value the report is *allowed* to carry —
    // `E6Secret.digest` exists so an operator holding a suspected credential can
    // confirm it locally, and `E6FieldRecord.findingDigests` puts the same hash
    // on the field that matched. So this asserts nothing about them beyond the
    // fact that they are hashes: a report that carried a digest where the value
    // was would already have failed the scan above.
    assert.ok(E6_SECRET_CORPUS.every((secret) => secret.digest.length === 64));
    // What it does carry is the marker vocabulary, and only from the published set.
    const published = new Set(e6AllLeakMarkers());
    const found = report.match(/<<leak:[^>]*>>/g) ?? [];
    assert.ok(found.length > 0, 'no leak markers in the report, so this scan proves nothing');
    for (const marker of found) {
      assert.ok(published.has(marker), `the report invented the marker ${marker}`);
    }
  });

  it('audits the whole run against the corpus and the writers, finding nothing to disagree about', () => {
    // The report publishes the audit it ran, not the writer objects it ran on,
    // so the checks are made against what is published: agreement is the claim.
    // The pipeline's leak attribution and an independent scan of the stored bytes
    // name the same sinks, no writer is silent, and every sink in the report has
    // at least one write behind it.
    const audit = RUN.audit;
    assert.deepEqual([...audit.disagreements], []);
    assert.deepEqual([...audit.markerDisagreements], []);
    assert.deepEqual([...audit.silentWriters], []);
    assert.ok(audit.writesObserved > 0);
    assert.ok(audit.storesInspected > 0);
    assert.equal(audit.writesObserved, RUN.sinks.reduce((total, summary) => total + summary.writes, 0));
    assert.deepEqual([...RUN.sinks.map((summary) => summary.writer)].sort(), [...E6_WRITER_NAMES].sort());
    for (const summary of RUN.sinks) {
      assert.ok(summary.writes > 0, `${summary.writer} is in the report with no write behind it`);
    }
  });
});

const NEGATIVE_CONTROL_ARM_LABEL = 'control+';

/* -------------------------------------------------------------------------- */
/* G9                                                                         */
/* -------------------------------------------------------------------------- */

const summary = (arm: Arm, observations: number, contained: number) => ({
  arm,
  mode: E6_ARM_MODES[arm],
  observations,
  contained,
  recall: observations === 0 ? null : contained / observations,
  ciLower: 0,
  ciUpper: 1,
  secretsContained: 0,
  secrets: 0,
  writesRefused: 0,
});

/** A binding that claims the production codec. Only F2 can honestly set this. */
const claimsProduction = (id = 'pretends-to-be-production'): E6RedactorBinding => ({
  ...fakeBinding(),
  id,
  productionCodec: true,
});

describe('e6: G9', () => {
  it('is a 100% one-sample threshold, read on the shipping arm', () => {
    assert.equal(G9_RECALL_THRESHOLD, 1);
    const [gate] = evaluateE6Gates(RUN.recall, fakeBinding());
    assert.ok(gate !== undefined);
    assert.equal(gate?.gate, 'G9');
    assert.equal(gate?.arm, 'treatment');
    assert.equal(gate?.blocking, true);
    assert.equal(gate?.threshold, 1);
  });

  it('is inconclusive on a fake codec however clean the run is', () => {
    const [gate] = evaluateE6Gates(
      [summary('control', 168, 0), summary('control+', 168, 0), summary('treatment', 168, 168)],
      fakeBinding(),
    );
    assert.equal(gate?.recall, 1);
    assert.equal(
      gate?.ciClearsConfidenceFloor,
      true,
      'the interval is not the problem; the codec is — 168/168 clears the 95% floor at n=73',
    );
    assert.equal(gate?.status, 'inconclusive');
    assert.equal(gate?.productionCodec, false);
    assert.match(gate?.detail ?? '', /stand-in/);
    assert.match(gate?.detail ?? '', /TODO\(WS-F, F2\)/);
  });

  it('has no "does the interval clear 100%" field, because none can ever be true', () => {
    // The Wilson lower bound at `x = n` is `n / (n + z^2)`, so at G9's absolute
    // threshold of 1 it is below 1 for every finite n. A boolean that is
    // permanently false is a boolean whose `false` gets read as a failing
    // statistical check, so the verdict reports the 95% confidence floor under
    // its own name and this asserts the two thresholds stay distinct.
    const [gate] = evaluateE6Gates(
      [summary('control', 168, 0), summary('control+', 168, 0), summary('treatment', 168, 168)],
      claimsProduction(),
    );
    assert.equal(gate?.threshold, 1);
    assert.equal(gate?.ciClearsConfidenceFloor, true);
    assert.ok((gate?.ciLower ?? 0) < 1, 'a finite interval cannot reach 1');
    assert.ok((gate?.ciLower ?? 0) >= E6_RECALL_CONFIDENCE);
    assert.equal(
      Object.keys(gate ?? {}).includes('ciClearsThreshold'),
      false,
      'the permanently-false predicate is back',
    );
    // And the floor moves the observation target, not the threshold.
    const [thin] = evaluateE6Gates([summary('treatment', 8, 8)], claimsProduction());
    assert.equal(thin?.ciClearsConfidenceFloor, false);
  });

  it('says so in the report of a real run, not only in a unit test of the gate', () => {
    const [gate] = RUN.gates;
    assert.equal(gate?.status, 'inconclusive');
    assert.equal(gate?.recall, 1);
    assert.equal(gate?.productionCodec, false);
    assert.match(RUN.provenance.todos.join(' '), /@strata-ctx\/security/);
  });

  it('observes only a production codec, a full pass, and enough observations to stand behind', () => {
    // Reached with a synthetic summary and a binding that lies about itself,
    // deliberately: a gate that has no reachable 'observed' state is a gate
    // whose pass path is untested, and an untested pass path is the one that
    // gets shipped.
    const [gate] = evaluateE6Gates(
      [summary('control', 168, 0), summary('control+', 168, 0), summary('treatment', 168, 168)],
      claimsProduction(),
    );
    assert.equal(gate?.status, 'observed');
    assert.equal(gate?.productionCodec, true);
  });

  it('fails on a single leak, because the threshold is absolute and not averaged', () => {
    const [gate] = evaluateE6Gates(
      [summary('control', 168, 0), summary('control+', 168, 0), summary('treatment', 168, 167)],
      claimsProduction(),
    );
    assert.equal(gate?.status, 'not_observed');
    assert.match(gate?.detail ?? '', /no partial-credit band/);
  });

  it('fails when the redactor has a rule set but no entropy pass', () => {
    const [gate] = evaluateE6Gates(
      [summary('control', 168, 0), summary('control+', 168, 0), summary('treatment', 168, 147)],
      claimsProduction(),
    );
    assert.equal(gate?.status, 'not_observed');
    assert.ok((gate?.recall ?? 1) < 1);
  });

  it('is inconclusive when the shipping arm never ran, instead of scoring a null as a pass', () => {
    // `null >= 1` is true in JavaScript. A gate that reads the rate without
    // checking whether the arm produced one is a gate that passes on a run where
    // nothing was measured.
    const [gate] = evaluateE6Gates([summary('control', 168, 0), summary('control+', 168, 0), summary('treatment', 0, 0)], claimsProduction());
    assert.equal(gate?.observations, 0);
    assert.equal(gate?.recall, null);
    assert.equal(gate?.status, 'inconclusive');
    assert.match(gate?.detail ?? '', /never measured/);
  });

  it('is inconclusive on a production codec with too few observations, and prints the count', () => {
    const [gate] = evaluateE6Gates([summary('treatment', 8, 8)], claimsProduction());
    assert.equal(gate?.status, 'inconclusive');
    assert.match(gate?.detail ?? '', /8 observations and the claim needs 73/);
  });

  it('reports both negative controls and never uses them to pass', () => {
    const [gate] = evaluateE6Gates(
      [summary('control', 168, 0), summary('control+', 168, 168), summary('treatment', 168, 168)],
      claimsProduction(),
    );
    assert.equal(gate?.negativeControlRecall.control, 0);
    assert.equal(gate?.negativeControlRecall['control+'], 1);
    assert.equal(gate?.status, 'observed', 'a control+ that did not leak must not be able to pass or fail the gate');
    assert.match(gate?.detail ?? '', /cannot see a leak at all/);
  });

  it('states which reading of §5\'s "All" it used, because the literal reading fails forever', () => {
    const [gate] = evaluateE6Gates(RUN.recall, fakeBinding());
    assert.match(gate?.detail ?? '', /registers G9 over "All"/);
    assert.match(gate?.detail ?? '', /negative controls are reported here/);
  });
});

/* -------------------------------------------------------------------------- */
/* False positives                                                             */
/* -------------------------------------------------------------------------- */

describe('e6: the false-positive report, which is the other half of §E6', () => {
  const treatment = measureE6FalsePositives('treatment', fakeRedactor('placeholder'));

  it('offers every control at every insertion point', () => {
    assert.equal(treatment.samples, E6_BENIGN_CORPUS.length * E6_INSERTION_POINT_NAMES.length);
    assert.equal(treatment.samples, 105);
  });

  it('reports zero false positives for a redactor with the value brakes on', () => {
    assert.equal(treatment.flagged, 0, JSON.stringify(treatment.offenders, null, 1));
    assert.equal(treatment.rewritten, 0);
    assert.equal(treatment.blocked, 0);
    assert.deepEqual([...treatment.offenders], []);
    assert.equal(treatment.unusable, false);
  });

  it('keeps "flagged" and "rewritten" apart, because in log mode they disagree completely', () => {
    const logged = measureE6FalsePositives('control+', fakeRedactor('log', { rules: EATS_IDENTIFIERS }));
    const rewritten = measureE6FalsePositives('treatment', fakeRedactor('placeholder', { rules: EATS_IDENTIFIERS }));
    assert.equal(logged.flagged, logged.samples, 'a log-mode redactor reports every finding');
    assert.equal(logged.rewritten, 0, 'and rewrites none of them, which is the entire point of log mode');
    assert.equal(rewritten.rewritten, rewritten.samples);
    assert.equal(logged.unusable, false, 'flagging without rewriting has not eaten anything yet');
  });

  it('calls a redactor that eats identifiers unusable, which is what §E6\'s 20% is for', () => {
    // 100% recall, and unusable. This is the case E6's second sentence exists
    // for: the recall column alone would call this redactor perfect.
    const eats = measureE6FalsePositives('treatment', fakeRedactor('placeholder', { rules: EATS_IDENTIFIERS }));
    assert.equal(eats.rewriteRate, 1);
    assert.equal(eats.unusable, true);
    assert.equal(eats.unusableByRewriteRate, true);
    assert.equal(E6_FALSE_POSITIVE_UNUSABLE_RATE, 0.2);
  });

  it('measures character loss on ordinary output only, so destroying a lockfile cannot average itself away', () => {
    const eats = measureE6FalsePositives('treatment', fakeRedactor('placeholder', { rules: EATS_IDENTIFIERS }));
    assert.ok((eats.characterLossRate ?? 0) > 0, 'the ordinary-output controls were not measured');
    const ordinary = E6_BENIGN_CORPUS.filter((entry) => entry.kind === 'ordinary_output');
    const expectedChars = ordinary.reduce(
      (total, entry) => total + E6_INSERTION_POINT_NAMES.reduce((sum, point) => sum + renderE6Carrier(point, entry.value).length, 0),
      0,
    );
    assert.equal(eats.ordinaryOutputCharacters, expectedChars);
    assert.ok(eats.ordinaryOutputCharacters < eats.samples * 200, 'the denominator is not dominated by the lockfiles');
  });

  it('shows each value brake earning its keep, one control at a time', () => {
    // Each control here is the *reason* one brake exists, and each is checked
    // against the same redactor with only `valueIsRedactable` switched off. A
    // count would do less: "without brakes 46 of 105 samples are flagged" says
    // something is doing the work without saying which predicate, and a brake
    // that silently stopped firing would be absorbed by the others.
    //
    // The unbraked run is deliberately not asserted to flag *every* sample. It
    // cannot: `ordinary_output` prose carries no token any rule matches, so the
    // sharpest statement available is that each named control is an offender
    // unbraked and not an offender braked.
    const braked = measureE6FalsePositives('treatment', fakeRedactor('placeholder'));
    const unbraked = measureE6FalsePositives('treatment', fakeRedactor('placeholder', { noValueBrakes: true }));
    const brakedIds = new Set(braked.offenders.map((sample) => sample.benignId));
    const unbrakedIds = new Set(unbraked.offenders.map((sample) => sample.benignId));

    const cases: readonly { readonly id: string; readonly brake: string }[] = [
      { id: 'e6-benign-lockfile-npm', brake: 'INTEGRITY_FORMAT' },
      { id: 'e6-benign-lockfile-pnpm', brake: 'INTEGRITY_FORMAT' },
      { id: 'e6-benign-digest-content', brake: 'HEX_RUN' },
      { id: 'e6-benign-git-sha-merge', brake: 'HEX_RUN' },
      { id: 'e6-benign-asset-chunk', brake: 'CONTENT_HASHED_ASSET' },
      { id: 'e6-benign-output-env-example', brake: 'PLACEHOLDER_LEAD' },
    ];
    for (const { id, brake } of cases) {
      assert.ok(E6_BENIGN_CORPUS.some((entry) => entry.id === id), `${brake}: no control named ${id} in the corpus`);
      assert.equal(unbrakedIds.has(id), true, `${brake} earns nothing: ${id} is clean even with the brakes off`);
      assert.equal(brakedIds.has(id), false, `${brake} did not stop ${id}`);
    }
    assert.ok(unbraked.flagged > braked.flagged, 'the brakes must reduce the flagged count');
    assert.equal(braked.flagged, 0);
    assert.equal(unbraked.rewritten, unbraked.flagged, 'an offender in redact mode is rewritten');
    assert.ok(
      unbraked.flagged < unbraked.samples,
      'a prose control matches no rule, so the unbraked run cannot flag every sample',
    );
  });

  it('keeps the assigned-value floor below every corpus secret', () => {
    // The floor exists to rule out `x-api-key: "dist"`. It must not be the reason
    // a real secret is missed, so it is asserted against the corpus rather than
    // argued for in a comment: every value the assignment rule has to catch is
    // longer than the floor, by the margin it needs.
    const shortest = Math.min(
      ...E6_SECRET_CORPUS.filter((secret) => secret.kind === 'env_value').map((secret) => secret.value.length),
    );
    assert.ok(
      shortest > MIN_ASSIGNED_VALUE_LENGTH,
      `the shortest env secret is ${shortest} characters and the floor is ${MIN_ASSIGNED_VALUE_LENGTH}`,
    );
    assert.equal(MIN_ASSIGNED_VALUE_LENGTH, 16);
    const envExample = E6_BENIGN_CORPUS.find((entry) => entry.value.includes('changeme'));
    assert.ok(envExample !== undefined, 'no .env.example control in the corpus');
    for (const point of E6_INSERTION_POINT_NAMES) {
      const text = renderE6Carrier(point, envExample.value);
      const applied = applyE6Redaction(fakeRedactor('placeholder'), { insertionPoint: point, text });
      assert.equal(
        applied.durableText,
        text,
        `${point}: a placeholder .env.example is ordinary output and must come back byte-identical`,
      );
    }
  });

  it('brackets every rate with a Wilson interval', () => {
    for (const report of [treatment, measureE6FalsePositives('control', fakeRedactor('off'))]) {
      assert.ok(report.observationCiLower <= (report.observationRate ?? 0));
      assert.ok((report.observationRate ?? 0) <= report.observationCiUpper);
      assert.ok(report.rewriteCiLower <= (report.rewriteRate ?? 0));
      assert.ok((report.rewriteRate ?? 0) <= report.rewriteCiUpper);
      assert.ok(report.observationCiLower >= 0 && report.observationCiUpper <= 1);
    }
  });

  it('reports the off arm as finding nothing, which is what "no redaction" means', () => {
    const off = measureE6FalsePositives('control', fakeRedactor('off'));
    assert.equal(off.flagged, 0);
    assert.equal(off.rewritten, 0);
    assert.deepEqual([...off.offenders], []);
  });
});
