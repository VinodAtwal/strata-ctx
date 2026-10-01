import { createHash } from 'node:crypto';

import {
  EVAL_FIXTURE_FORMAT_VERSION,
  parseFixture,
  validateFixture,
  type FixtureIssueCode,
} from '../fixture.js';
import { runSuite, type RunOptions } from '../runner.js';
import { wilsonInterval } from '../statistics.js';
import {
  NEGATIVE_CONTROL_ARM,
  type Arm,
  type EvalFixture,
  type SuiteId,
  type SyncArmRunner,
  type RunReport,
} from '../types.js';

/**
 * F1-10 — E6, secret redaction. docs/evaluation.md §E6, gate G9.
 *
 * §E6 asks: *"does the compression layer leak secrets the plain context would not
 * have?"* — and the reason it exists is stated in the next line, and the reason
 * is not a quality concern:
 *
 * > The whole design moves data into **new durable places** — gists, the artifact
 * > store, telemetry. Compression is not a DLP control; it changes **where**
 * > sensitive data lives. A secret in a tool result is transient in the raw
 * > context but becomes **permanent** in a gist unless you stop it.
 *
 * So the property under test is not "does the redactor find secrets" but "does a
 * secret survive anywhere downstream of the stage". Those are different questions
 * and the second is the one a release is blocked on, which is why every
 * assertion in this file is phrased as containment at a named destination rather
 * than as a detection rate:
 *
 * - recall 100% on the corpus (G9), measured at **seven insertion points**, not
 *   one, because a redactor wired into the tool-result path only and not the
 *   commit-message path leaks through the other six;
 * - the secret appears in **no** durable write: the gist, the artifact store,
 *   **any** telemetry sink, or `ctx_status` (§E6's "and `ctx_status`", which is a
 *   status line and therefore a place a secret ends up by accident);
 * - in `block` mode the blocked field is not forwarded to the model at all;
 * - **and the false-positive rate is reported**, not just recall — §E6 is
 *   explicit that "a redactor that eats 20% of ordinary output is unusable, and
 *   recall-only suites hide that".
 *
 * ## "Any telemetry sink" means more than one, and that is the whole point
 *
 * §E6 says *any*, and a suite that checks one sink has checked whether a map
 * happened to contain the right key. So this file binds **three** telemetry
 * writers — an in-process memory sink, a JSONL-shaped sink, and a tee that fans
 * one write out to both — and requires each of them to be leak-free. The tee is
 * not a convenience: a fan-out sink is a place a redaction policy can be applied
 * on the way in and lost on the way out to a second leaf, and only a writer that
 * genuinely forwards can catch that.
 *
 * Four durable *categories* (`gist`, `artifact_store`, `telemetry`, `ctx_status`)
 * across six concrete writers. docs/evaluation.md §E6 "Source of truth: the secret
 * corpus itself, published with the project so others can run it" — the corpus is
 * exported from this module for exactly that reason.
 *
 * ## The two things this suite cannot claim, and says so in its own output
 *
 * 1. **The redactor is injected, never imported.** `Redactor` is a parameter.
 *    The offline tests supply a shape-based fake; F2 supplies
 *    `packages/security`'s `RedactionEngine`. `E6RedactorBinding.productionCodec`
 *    is the flag that distinguishes them, and when it is false — which it always
 *    is offline — **G9 is reported `inconclusive` no matter how good the numbers
 *    are.** A redactor suite that reports "100% recall" while measuring its own
 *    fake is a security number that means nothing, and the only defence is to
 *    make the number impossible to publish in that state.
 * 2. **The writers are injected for the same reason, and the reason cuts the
 *    other way.** A durable sink in production applies its own fail-closed
 *    persistence gate (`assertPersistable` in `packages/security/src/redact.ts`),
 *    which refuses a write containing a certain-confidence secret *whatever the
 *    mode says*. If the offline reference writers applied that gate, the
 *    negative-control arms could not leak and this suite would measure the gate
 *    instead of the redaction. So the reference writers record exactly what they
 *    are handed, and that is why G9 is re-run against the real writers in F2.
 *    `TODO(WS-F, F2)` on both, and the provenance block carries the
 *    `productionCodec` flag rather than a claim.
 *
 * ## The production catalogue has a gap this corpus walks into
 *
 * Verified against the catalogue at `packages/security/src/patterns.ts` while
 * writing this file: the `assigned_secret` rule matches `DB_PASSWORD=value` and
 * `password: "value"`, and it does **not** match `"DB_PASSWORD": "value"`. The
 * reason is the delimiter class — the value group is preceded by `\s*[:=]\s*`,
 * and a JSON key is closed by a quote the pattern never skips. So a
 * `tool_result` that is a JSON object, which is the most ordinary tool result
 * there is, can carry an `.env`-shaped secret past the pattern layer, and
 * entropy is the only thing left — and entropy is deliberately capped at
 * `probable` and cannot be the sole defence.
 *
 * The fake redactor in `packages/eval/test/e6-redaction.test.ts` covers the JSON
 * form, which makes it a *stricter* redactor than production and therefore not a
 * faithful copy of it. That delta is `TODO(WS-F, F2)`, and it is one of the
 * reasons this file will not let itself report G9 as `observed` offline. A suite
 * that hid a known catalogue gap behind a green number would be worse than no
 * suite.
 *
 * ## Arms are redaction configurations, and G9 does not score "All"
 *
 * The three arms are the same three the harness defines everywhere else
 * (`control`, `control+`, `treatment`), and here they are three redactor
 * configurations rather than three compression strategies:
 *
 * | arm        | redactor mode | what it is                                    |
 * |------------|---------------|-----------------------------------------------|
 * | `control`  | `off`         | the uncompressed baseline: nothing is rewritten |
 * | `control+` | `log`         | the negative control: findings, no rewriting    |
 * | `treatment`| `placeholder` | what we ship: findings **and** rewriting        |
 *
 * G9 is pre-registered over "All". Read literally, that asks the `off` arm to
 * achieve 100% recall, which is a constant — it fails in every run, in every
 * code change, forever — and a gate that is a constant is not a gate; it is a
 * paragraph of the gate table. So G9 is evaluated on the **shipping** arm
 * (`treatment`), the two control arms are reported beside it as the negative
 * controls they are, and `evaluateE6Gates` says so in the verdict's own `detail`
 * string rather than leaving it to a reader of the report. If a reviewer wants
 * the literal reading, the per-arm recall table is right there and it shows both
 * controls at 0%.
 *
 * ## Containment is measured at the field, and the field is the unit of recall
 *
 * One secret at one insertion point is one observation. The corpus is 24 secrets
 * across 8 kinds and there are 7 insertion points, so the shipping arm produces
 * 168 observations — and `E6_RECALL_OBSERVATION_TARGET` is the smallest n at
 * which a 100% point rate has a Wilson **lower** bound above 0.95, which for a
 * one-sample proportion is `n >= 0.95 z^2 / 0.05 = 73`. Below that, 100% of 24
 * is not a 100% claim, and the gate says `inconclusive` with the interval
 * printed rather than reporting the point rate alone. Observations within a
 * secret are not independent, so per-secret containment is reported beside the
 * pooled rate and the pooled interval is labelled as the unit it is pooled over.
 *
 * ## Nothing in this file may put a secret in a report
 *
 * The corpus holds credential-*shaped* synthetic strings because a redactor that
 * is fed invented values measures nothing. Every artefact that leaves this module
 * therefore carries ids, kinds, digests, booleans and counts — never a value and
 * never a byte offset. Leak markers are the safe string `<<leak:…>>`, the same
 * discipline E1 uses for its forbidden markers, and `e6-report-secrecy` is a test
 * that serialises the whole run result and searches it for all 24 values.
 */

// ---------------------------------------------------------------- constants

/** docs/evaluation.md Part 2, E6. Mirrored as a literal, as in E1 (AGENTS.md §12.1). */
export const E6_SUITE_ID: SuiteId = 'E6';

export const E6_SUITE_NAME = 'e6-redaction';

/** The three redaction configurations. See the arm table in the module header. */
export const E6_ARMS: readonly Arm[] = Object.freeze<Arm[]>([
  'control',
  'control+',
  'treatment',
]);

/**
 * G9, docs/evaluation.md §5: *"Secret redaction recall | **100%** on the secret
 * corpus | All | Product requirement F18"*.
 *
 * A rate, read on the point estimate, and absolute: there is no tolerance to
 * tune and no "well, one in ten thousand" reading available. The `All` arm
 * question is answered in the module header and repeated in the verdict.
 */
export const G9_RECALL_THRESHOLD = 1;

/**
 * The confidence the recall claim is held to, and the n that claim needs.
 *
 * For a one-sample proportion with `x = n`, the Wilson lower bound collapses to
 * `n / (n + z^2)`. Requiring that to clear `E6_RECALL_CONFIDENCE` gives
 * `n >= c z^2 / (1 - c)`, which at `c = 0.95` and `z = 1.959963984540054` is
 * 72.99. So 73 observations is the smallest n at which a perfect run is a claim
 * about the rate rather than a claim about the sample, and the constant is
 * computed rather than written down because a hand-copied `73` invites the next
 * person to change the confidence level without moving this.
 */
export const E6_RECALL_CONFIDENCE = 0.95;

const Z_95 = 1.959963984540054;

export const E6_RECALL_OBSERVATION_TARGET = Math.ceil(
  (E6_RECALL_CONFIDENCE * Z_95 * Z_95) / (1 - E6_RECALL_CONFIDENCE),
);

/**
 * §E6: *"a redactor that eats 20% of ordinary output is unusable"*.
 *
 * Reported as a flag, not a gate. The sentence is an argument, not a
 * pre-registered threshold — there is no gate in §5 for false positives, and
 * inventing a blocking one here would be a threshold nobody agreed to, aimed at
 * a number this suite cannot even measure honestly yet (it measures a fake
 * redactor). It is a `flagged` field on the report so a reader sees the figure
 * next to recall, which is the entire reason §E6 asks for it.
 */
export const E6_FALSE_POSITIVE_UNUSABLE_RATE = 0.2;

/** A secret is only a leak if this much of it is what lands somewhere. */
export const E6_MINIMUM_SECRET_LENGTH = 16;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** `sha256` of a string, the one hash this file needs. Deterministic, no I/O. */
const digestOf = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

// ------------------------------------------------------------------ taxonomy

/**
 * The eight secret classes docs/evaluation.md §E6 names, verbatim.
 *
 * "API keys, JWTs, private keys, connection strings with passwords, `.env`
 * values, AWS keys, bearer tokens, high-entropy strings" — eight items, eight
 * kinds, and `lintE6Corpus` refuses a corpus that does not cover all of them. A
 * suite that covers six of the eight and reports a percentage is reporting a
 * percentage of the wrong denominator.
 *
 * The names are E6's own, not `SecretKind` from `@strata-ctx/security`: this
 * package has no dependencies (AGENTS.md §12.1), and a suite whose vocabulary
 * silently tracks another package's enum is a suite that changes meaning when
 * somebody adds a kind there. The mapping is reported, not assumed.
 */
export const E6_SECRET_KINDS = [
  'api_key',
  'jwt',
  'private_key',
  'connection_string',
  'env_value',
  'aws_key',
  'bearer_token',
  'high_entropy',
] as const;
export type E6SecretKind = (typeof E6_SECRET_KINDS)[number];

/**
 * The benign classes, chosen for what they do to a redactor rather than for what
 * they look like.
 *
 * Every entry here is a string an entropy-based redactor wants to delete: a
 * lockfile integrity hash, a sha256 digest, a minified asset's data URI, a git
 * SHA. §E6's "a redactor that eats 20% of ordinary output is unusable" is
 * measured *here* and nowhere else — a suite whose false-positive set is
 * `password = changeme` proves nothing about a redactor, because no deployment
 * runs with `changeme` in its lockfile.
 */
export const E6_BENIGN_KINDS = [
  'lockfile_integrity',
  'sha256_digest',
  'minified_asset',
  'git_sha',
  'ordinary_output',
] as const;
export type E6BenignKind = (typeof E6_BENIGN_KINDS)[number];

/** The seven insertion points of §E6, in the order the document lists them. */
export const E6_INSERTION_POINT_NAMES = [
  'tool_result',
  'file_read',
  'agent_prose',
  'error_trace',
  'commit_message',
  'filename',
  'agent_output',
] as const;
export type E6InsertionPointName = (typeof E6_INSERTION_POINT_NAMES)[number];

/** The four durable destinations of §E6, named as the document names them. */
export const E6_SINK_CATEGORIES = ['gist', 'artifact_store', 'telemetry', 'ctx_status'] as const;
export type E6SinkCategory = (typeof E6_SINK_CATEGORIES)[number];

/** Six concrete writers: one per single-writer category, three for `telemetry`. */
export const E6_WRITER_NAMES = [
  'gist',
  'artifact_store',
  'telemetry.memory',
  'telemetry.jsonl',
  'telemetry.tee',
  'ctx_status',
] as const;
export type E6WriterName = (typeof E6_WRITER_NAMES)[number];

/** Which category each writer belongs to. §E6's "any telemetry sink" is this row. */
export const E6_WRITER_CATEGORIES: Readonly<Record<E6WriterName, E6SinkCategory>> = Object.freeze({
  gist: 'gist',
  artifact_store: 'artifact_store',
  'telemetry.memory': 'telemetry',
  'telemetry.jsonl': 'telemetry',
  'telemetry.tee': 'telemetry',
  ctx_status: 'ctx_status',
});

/**
 * The safe marker a leak is reported with, in place of the secret.
 *
 * `<<leak:api_key:tool_result>>`. It has to be a marker rather than the value
 * because this string reaches `RunReport.cases[].arms[].violations[].marker` and
 * from there into a committed, diffed artefact — the same reason E1's forbidden
 * markers are literals with no secret in them.
 */
export const e6LeakMarker = (secretId: string, insertionPoint: E6InsertionPointName): string =>
  `<<leak:${secretId}:${insertionPoint}>>`;

/** Every marker the suite can emit, for the test that scans a report for them. */
export const e6AllLeakMarkers = (): readonly string[] =>
  Object.freeze(
    E6_SECRET_CORPUS.flatMap((secret) =>
      E6_INSERTION_POINT_NAMES.map((point) => e6LeakMarker(secret.id, point)),
    ),
  );

// ------------------------------------------------------------------- corpus

/**
 * One synthetic secret.
 *
 * `value` is the string that goes into a carrier; `secretSpan` is the exact
 * substring a leak detector hunts for downstream. They are equal for all 24
 * entries and are two fields rather than one so that a future entry can plant a
 * *partial* secret — the PEM header captured in a truncated terminal scroll is
 * the real-world case, and a corpus that could not express it would quietly
 * stop modelling that leak. `lintE6Corpus` asserts the weaker, general
 * relationship (`carrier(value).includes(secretSpan)`) rather than equality, so
 * such an entry does not have to fight the lint to be added.
 *
 * `digest` is `sha256(value)`, carried so an operator holding a suspected
 * credential can confirm a match by hashing it locally — the same reasoning as
 * `RedactionFinding.digest` in `packages/security/src/redact.ts`, and for the
 * same reason it is a hash and not a prefix: a per-finding value that identifies
 * one specific secret to a third party is a partial disclosure.
 */
export interface E6Secret {
  readonly id: string;
  readonly kind: E6SecretKind;
  readonly value: string;
  readonly secretSpan: string;
  readonly digest: string;
  readonly notes: string;
}

/** One benign control: a string an entropy-based redactor would like to delete. */
export interface E6Benign {
  readonly id: string;
  readonly kind: E6BenignKind;
  readonly value: string;
  readonly digest: string;
  readonly notes: string;
}

/**
 * The secret corpus. docs/evaluation.md §E6 "Source of truth: the secret corpus
 * itself, published with the project so others can run it."
 *
 * 24 entries, three per kind, so no kind's rate is decided by one string. Every
 * value is **synthetic and structurally inert**: the bodies are self-describing
 * (`E6FIXTURE`, `notreal`, `e6corpus`) and none is a credential for anything.
 * They still have to *look* like credentials, because a redactor fed invented
 * values measures nothing — that is the tension §E6's "published with the
 * project" creates and the reason each entry says in `notes` why it is safe to
 * commit.
 *
 * Shapes follow `packages/security/src/patterns.ts` exactly where they can:
 * `sk-ant-` for an API key, `eyJ….….…` for a JWT, a PEM block, a
 * `scheme://user:password@host` for a connection string, `KEY=value` for an
 * `.env` value, `AKIA` + 16 uppercase alphanumerics, `Bearer`/`Basic` + a
 * token, and an unlabelled 43-character base64url token for the entropy case.
 */
export const E6_SECRET_CORPUS: readonly E6Secret[] = Object.freeze<E6Secret[]>([
  // ---- api_key: `sk-ant-`, `sk-proj-`, `sk-live-` ----
  {
    id: 'e6-secret-api-key-anthropic',
    kind: 'api_key',
    value: 'sk-ant-e6corpus01fixturevalue0notreal0000000000001',
    secretSpan: 'sk-ant-e6corpus01fixturevalue0notreal0000000000001',
    digest: digestOf('sk-ant-e6corpus01fixturevalue0notreal0000000000001'),
    notes:
      'Anthropic-shaped key: `sk-ant-` plus a body that spells "e6corpus01…notreal" so a reader can see at ' +
      'a glance that committing it is safe. Caught by the `anthropic_api_key` rule at certain confidence.',
  },
  {
    id: 'e6-secret-api-key-project',
    kind: 'api_key',
    value: 'sk-proj-e6corpus02fixturevalue0notreal0000000000002',
    secretSpan: 'sk-proj-e6corpus02fixturevalue0notreal0000000000002',
    digest: digestOf('sk-proj-e6corpus02fixturevalue0notreal0000000000002'),
    notes:
      'Project-scoped variant. Matches the generic `sk-` rule, so it is the case that proves a catalogue ' +
      'listing a specific shape *before* the generic one still produces one clean redaction.',
  },
  {
    id: 'e6-secret-api-key-live',
    kind: 'api_key',
    value: 'sk-live-e6corpus03fixturevalue0notreal0000000000003',
    secretSpan: 'sk-live-e6corpus03fixturevalue0notreal0000000000003',
    digest: digestOf('sk-live-e6corpus03fixturevalue0notreal0000000000003'),
    notes:
      'A third prefix variant, so the corpus is not satisfied by two strings that differ in one character. ' +
      'No production rule names `sk-live-`; it is caught only by the generic rule, which is the honest ' +
      'reason it is in the corpus.',
  },
  // ---- jwt ----
  {
    id: 'e6-secret-jwt-claims',
    kind: 'jwt',
    value:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlNmNvcnB1cy0wMSIsInNjb3BlIjoiY29udGV4dCJ9.e6jwt01signaturenotrealaaaaaaaaaaaaaaaaaaa',
    secretSpan:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlNmNvcnB1cy0wMSIsInNjb3BlIjoiY29udGV4dCJ9.e6jwt01signaturenotrealaaaaaaaaaaaaaaaaaaa',
    digest: digestOf(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJlNmNvcnB1cy0wMSIsInNjb3BlIjoiY29udGV4dCJ9.e6jwt01signaturenotrealaaaaaaaaaaaaaaaaaaa',
    ),
    notes:
      'The header is real base64 of a real JWT header — that is what makes `eyJ` a shape rather than a ' +
      'coincidence — and the payload decodes to readable text saying this is a fixture. Nothing signs it.',
  },
  {
    id: 'e6-secret-jwt-service',
    kind: 'jwt',
    value:
      'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlNmNvcnB1cy0wMiJ9.e6jwt02signaturenotrealbbbbbbbbbbbbbbbbbbbbbb',
    secretSpan:
      'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlNmNvcnB1cy0wMiJ9.e6jwt02signaturenotrealbbbbbbbbbbbbbbbbbbbbbb',
    digest: digestOf(
      'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlNmNvcnB1cy0wMiJ9.e6jwt02signaturenotrealbbbbbbbbbbbbbbbbbbbbbb',
    ),
    notes: 'RS256 rather than HS256, and a shorter header segment, so the three-segment rule does the work.',
  },
  {
    id: 'e6-secret-jwt-refresh',
    kind: 'jwt',
    value:
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.e6jwt03refreshsig0000000000000000000000000000',
    secretSpan:
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.e6jwt03refreshsig0000000000000000000000000000',
    digest: digestOf(
      'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.e6jwt03refreshsig0000000000000000000000000000',
    ),
    notes:
      'A refresh token: the case where a JWT outlives the session that received it, which is why a redaction ' +
      'that only covers tool results does not cover a refresh token pasted into a status line.',
  },
  // ---- private_key ----
  {
    id: 'e6-secret-private-key-rsa',
    kind: 'private_key',
    value:
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      'eE6FIXTUREaW9ucmVhbGxpbmVmaXh0dXJlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw\n' +
      'bEVGSE9sZGVTaGF0dXJlZm9ydGhlU2Vjb25kTGluZU9mVGhpcy1Cb2R5\n' +
      '-----END RSA PRIVATE KEY-----',
    secretSpan:
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      'eE6FIXTUREaW9ucmVhbGxpbmVmaXh0dXJlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw\n' +
      'bEVGSE9sZGVTaGF0dXJlZm9ydGhlU2Vjb25kTGluZU9mVGhpcy1Cb2R5\n' +
      '-----END RSA PRIVATE KEY-----',
    digest: digestOf(
      '-----BEGIN RSA PRIVATE KEY-----\n' +
        'eE6FIXTUREaW9ucmVhbGxpbmVmaXh0dXJlMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw\n' +
        'bEVGSE9sZGVTaGF0dXJlZm9ydGhlU2Vjb25kTGluZU9mVGhpcy1Cb2R5\n' +
        '-----END RSA PRIVATE KEY-----',
    ),
    notes:
      'A three-line PEM whose body is English with the base64 padding stripped, so it is obviously not a key. ' +
      'The multi-line shape matters: a redactor that rewrites single-line carriers can pass the other six ' +
      'insertion points and fail this one.',
  },
  {
    id: 'e6-secret-private-key-pkcs8',
    kind: 'private_key',
    value:
      '-----BEGIN PRIVATE KEY-----\n' +
      'eE6FIXTUREwcm9wNXhzdGF0ZW1lbnRpYWxpemF0aW9uMDAwMDAwMDAwMDAwMDAwMDAw\n' +
      '-----END PRIVATE KEY-----',
    secretSpan:
      '-----BEGIN PRIVATE KEY-----\n' +
      'eE6FIXTUREwcm9wNXhzdGF0ZW1lbnRpYWxpemF0aW9uMDAwMDAwMDAwMDAwMDAwMDAw\n' +
      '-----END PRIVATE KEY-----',
    digest: digestOf(
      '-----BEGIN PRIVATE KEY-----\n' +
        'eE6FIXTUREwcm9wNXhzdGF0ZW1lbnRpYWxpemF0aW9uMDAwMDAwMDAwMDAwMDAwMDAw\n' +
        '-----END PRIVATE KEY-----',
    ),
    notes:
      'PKCS#8 rather than PKCS#1, and a *two*-line block, which is what a truncated scroll or a bad log ' +
      'formatter actually captures. The span is the whole block, as it is for the other two: a redaction that ' +
      'keeps the base64 body and drops the `BEGIN` line has not removed a key.',
  },
  {
    id: 'e6-secret-private-key-ec',
    kind: 'private_key',
    value:
      '-----BEGIN EC PRIVATE KEY-----\n' +
      'eE6FIXTUREhNXJvdXBlY3VyaXZhdGlvbi1rZXktb2ZmaWNpYWwtZWxsaXBzZWRnbW9jaw==\n' +
      '-----END EC PRIVATE KEY-----',
    secretSpan:
      '-----BEGIN EC PRIVATE KEY-----\n' +
      'eE6FIXTUREhNXJvdXBlY3VyaXZhdGlvbi1rZXktb2ZmaWNpYWwtZWxsaXBzZWRnbW9jaw==\n' +
      '-----END EC PRIVATE KEY-----',
    digest: digestOf(
      '-----BEGIN EC PRIVATE KEY-----\n' +
        'eE6FIXTUREhNXJvdXBlY3VyaXZhdGlvbi1rZXktb2ZmaWNpYWwtZWxsaXBzZWRnbW9jaw==\n' +
        '-----END EC PRIVATE KEY-----',
    ),
    notes:
      'EC, so the `[A-Z0-9]{0,32} ` optional label in the production rule is exercised with a different ' +
      'algorithm word rather than the same one three times.',
  },
  // ---- connection_string ----
  {
    id: 'e6-secret-connection-postgres',
    kind: 'connection_string',
    value: 'postgres://e6reader:pgE6fixture01notreal@db.internal.example:5432/billing',
    secretSpan: 'pgE6fixture01notreal',
    digest: digestOf('postgres://e6reader:pgE6fixture01notreal@db.internal.example:5432/billing'),
    notes:
      'The only entry whose `secretSpan` is narrower than its `value`: §E6 says "connection strings with ' +
      'passwords", and the password is the secret. Redacting the whole DSN would also remove the host and ' +
      'the database name, which is the information an operator needs in order to rotate it.',
  },
  {
    id: 'e6-secret-connection-mongodb',
    kind: 'connection_string',
    value: 'mongodb+srv://e6reporter:moE6fixture02notreal@cluster0.e6mongo.example/prod',
    secretSpan: 'moE6fixture02notreal',
    digest: digestOf('mongodb+srv://e6reporter:moE6fixture02notreal@cluster0.e6mongo.example/prod'),
    notes: 'A `+srv` scheme, so the scheme class in the production rule is not exercised only by `postgres`.',
  },
  {
    id: 'e6-secret-connection-amqp',
    kind: 'connection_string',
    value: 'amqps://e6worker:amE6fixture03notreal@rabbit.internal.example:5671/events',
    secretSpan: 'amE6fixture03notreal',
    digest: digestOf('amqps://e6worker:amE6fixture03notreal@rabbit.internal.example:5671/events'),
    notes:
      'AMQP over TLS. A queue credential, which is the kind that leaks hardest: the value is routinely ' +
      'echoed by a broker CLI into a terminal that a coding agent then reads back as a tool result.',
  },
  // ---- env_value ----
  {
    id: 'e6-secret-env-db-password',
    kind: 'env_value',
    value: 'DB_PASSWORD=e6Env01FixturePasswordNotReal',
    secretSpan: 'e6Env01FixturePasswordNotReal',
    digest: digestOf('DB_PASSWORD=e6Env01FixturePasswordNotReal'),
    notes:
      'The single most common shape in a coding agent\'s tool output: a `.env` line. Note that this entry is ' +
      'caught when it is written `KEY=value` or `password: "value"` and is *not* caught when it is written ' +
      '`"KEY": "value"` — see the catalogue gap in the module header.',
  },
  {
    id: 'e6-secret-env-service-token',
    kind: 'env_value',
    value: 'SERVICE_API_TOKEN=e6env02fixturetokennotrealfixturevalue',
    secretSpan: 'e6env02fixturetokennotrealfixturevalue',
    digest: digestOf('SERVICE_API_TOKEN=e6env02fixturetokennotrealfixturevalue'),
    notes: 'A 40-character value with no shape of its own: only the assignment rule can see it.',
  },
  {
    id: 'e6-secret-env-signing-key',
    kind: 'env_value',
    value: 'SESSION_SIGNING_KEY=e6env03fixturesigningkeynotreal',
    secretSpan: 'e6env03fixturesigningkeynotreal',
    digest: digestOf('SESSION_SIGNING_KEY=e6env03fixturesigningkeynotreal'),
    notes:
      'Two prefix segments, so the rule that allows one optional `[A-Za-z0-9]{1,8}[_-]` prefix before the ' +
      'keyword is tested with the prefix actually present.',
  },
  // ---- aws_key ----
  {
    id: 'e6-secret-aws-access-key',
    kind: 'aws_key',
    value: 'AKIAE6FIXTURE0000000',
    secretSpan: 'AKIAE6FIXTURE0000000',
    digest: digestOf('AKIAE6FIXTURE0000000'),
    notes: '`AKIA` plus exactly 16 uppercase alphanumerics, which is the documented shape and nothing else is.',
  },
  {
    id: 'e6-secret-aws-session-key',
    kind: 'aws_key',
    value: 'ASIAE6FIXTURE0000001',
    secretSpan: 'ASIAE6FIXTURE0000001',
    digest: digestOf('ASIAE6FIXTURE0000001'),
    notes:
      '`ASIA` is a *temporary* credential, so it is the entry with the shortest real lifetime — which is ' +
      'the argument for redacting it before a gist rather than relying on rotation to clean up after it.',
  },
  {
    id: 'e6-secret-aws-broker-key',
    kind: 'aws_key',
    value: 'ABIAE6FIXTURE0000002',
    secretSpan: 'ABIAE6FIXTURE0000002',
    digest: digestOf('ABIAE6FIXTURE0000002'),
    notes: '`ABIA` is a broker role, the rarest of the four resource-type prefixes, so the corpus is not ' +
      'quietly limited to the one everybody remembers.',
  },
  // ---- bearer_token ----
  {
    id: 'e6-secret-bearer-provider',
    kind: 'bearer_token',
    value: 'Bearer e6bearer01fixturetokenvalue0notreal0000000000',
    secretSpan: 'e6bearer01fixturetokenvalue0notreal0000000000',
    digest: digestOf('Bearer e6bearer01fixturetokenvalue0notreal0000000000'),
    notes:
      'The scheme word is part of `value` and the span is only the credential, so a redaction that removes the ' +
      'scheme along with the token is detectable as a different result from one that keeps it.',
  },
  {
    id: 'e6-secret-bearer-basic',
    kind: 'bearer_token',
    value: 'Basic e6basic02fixturecredentialvalue00notreal0000',
    secretSpan: 'e6basic02fixturecredentialvalue00notreal0000',
    digest: digestOf('Basic e6basic02fixturecredentialvalue00notreal0000'),
    notes: '`Basic` rather than `Bearer`, because the rule covers both and a suite that only carries `Bearer` ' +
      'is testing half of it.',
  },
  {
    id: 'e6-secret-bearer-internal',
    kind: 'bearer_token',
    value: 'Bearer e6bearer03fixturetokenvalue0notreal0000000000',
    secretSpan: 'e6bearer03fixturetokenvalue0notreal0000000000',
    digest: digestOf('Bearer e6bearer03fixturetokenvalue0notreal0000000000'),
    notes: 'An internal service token, the shape that reaches a `ctx_status` line via a support bundle.',
  },
  // ---- high_entropy ----
  {
    id: 'e6-secret-entropy-opaque-a',
    kind: 'high_entropy',
    value: 'Q7Zt3rKq9WvN2xYb4mLp8RsD1gH6jF0cA5uEeIiOoUu',
    secretSpan: 'Q7Zt3rKq9WvN2xYb4mLp8RsD1gH6jF0cA5uEeIiOoUu',
    digest: digestOf('Q7Zt3rKq9WvN2xYb4mLp8RsD1gH6jF0cA5uEeIiOoUu'),
    notes:
      'Unlabelled, 43 characters, mixed case and digits. No deterministic rule can see this one, so it is the ' +
      'entry that separates a redactor with an entropy pass from one without.',
  },
  {
    id: 'e6-secret-entropy-opaque-b',
    kind: 'high_entropy',
    value: 'kR4pLdZ9wXnT2vQb7mHsYcF1jA6eG3uO0tIwE5rNq8Yx',
    secretSpan: 'kR4pLdZ9wXnT2vQb7mHsYcF1jA6eG3uO0tIwE5rNq8Yx',
    digest: digestOf('kR4pLdZ9wXnT2vQb7mHsYcF1jA6eG3uO0tIwE5rNq8Yx'),
    notes: 'A second shape of the same kind, so the entropy entry is not one lucky string.',
  },
  {
    id: 'e6-secret-entropy-opaque-c',
    kind: 'high_entropy',
    value: 'Wm8QbX2sNvJ5hKzT4pLdR9cYfA1eG7uO3tIwE6rNq0Yx',
    secretSpan: 'Wm8QbX2sNvJ5hKzT4pLdR9cYfA1eG7uO3tIwE6rNq0Yx',
    digest: digestOf('Wm8QbX2sNvJ5hKzT4pLdR9cYfA1eG7uO3tIwE6rNq0Yx'),
    notes: 'A third, differing from the second only in the first few characters.',
  },
]);

/**
 * The benign controls.
 *
 * §E6's second assertion is that "the false-positive rate is reported", and a
 * false-positive set made of `password = changeme` would not measure anything:
 * no deployment runs with `changeme` in its lockfile, and no coding agent reads a
 * 64-character sha256 digest out of a build log every minute of every day. So
 * every entry here is a string a real repository contains and a real agent
 * handles constantly, and the set is dominated — deliberately — by the shapes
 * entropy scoring loves.
 */
export const E6_BENIGN_CORPUS: readonly E6Benign[] = Object.freeze<E6Benign[]>([
  {
    id: 'e6-benign-lockfile-npm',
    kind: 'lockfile_integrity',
    value:
      'sha512-1o7YxKQ2mVbN8pLzRc4TjHnW6YdQ3sXeA0bFgUiOpKmZtNvCyDlSrAhBxEwPoQnJfMgVkHiJuTrEdSaWcQzXyVbNmLgKhIuJdFtGyReXoPbCzQaWv',
    digest: digestOf(
      'sha512-1o7YxKQ2mVbN8pLzRc4TjHnW6YdQ3sXeA0bFgUiOpKmZtNvCyDlSrAhBxEwPoQnJfMgVkHiJuTrEdSaWcQzXyVbNmLgKhIuJdFtGyReXoPbCzQaWv',
    ),
    notes:
      'An npm integrity hash: 88 base64 characters. This is the entry that decides whether a deployment can ' +
      'turn on the `possible` entropy band at all.',
  },
  {
    id: 'e6-benign-lockfile-pnpm',
    kind: 'lockfile_integrity',
    value:
      'sha512-8fHq2LpRtZx5MwNcYbVdGkA1sEjU7iO3pLnBfYuIoRtEhZqCvXmNbWkAsDfGyHjKlPqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKl',
    digest: digestOf(
      'sha512-8fHq2LpRtZx5MwNcYbVdGkA1sEjU7iO3pLnBfYuIoRtEhZqCvXmNbWkAsDfGyHjKlPqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKl',
    ),
    notes: 'A pnpm integrity hash, a different length from the npm one so length cannot be the discriminator.',
  },
  {
    id: 'e6-benign-lockfile-yarn',
    kind: 'lockfile_integrity',
    value:
      'sha512-3kMnBvCxZqLwErTyUiOpAsDfGhJkLqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKlZx',
    digest: digestOf(
      'sha512-3kMnBvCxZqLwErTyUiOpAsDfGhJkLqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFgHjKlZx',
    ),
    notes:
      'A yarn integrity hash, third length, and the one that ends in a long run of `H`s — the padding a base64 ' +
      'encoder leaves behind, which is the same tell as the font below and the same thing an entropy score ' +
      'has to survive.',
  },
  {
    id: 'e6-benign-digest-content',
    kind: 'sha256_digest',
    value: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    digest: digestOf('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'),
    notes: 'The sha256 of the string `test` — 64 hex characters, the most-copied digest in the world.',
  },
  {
    id: 'e6-benign-digest-module',
    kind: 'sha256_digest',
    value: '5d41402abc4b2a76b9719d911017c5921f4b3d206a6b7c8d9e0f1a2b3c4d5e6f',
    digest: digestOf('5d41402abc4b2a76b9719d911017c5921f4b3d206a6b7c8d9e0f1a2b3c4d5e6f'),
    notes: 'A module integrity digest from a bundler manifest.',
  },
  {
    id: 'e6-benign-digest-image',
    kind: 'sha256_digest',
    value: 'b94d27b99344d47eb0d4a4d8e1b1a9c36f2e5d4c3b2a19087e6d5c4b3a291807',
    digest: digestOf('b94d27b99344d47eb0d4a4d8e1b1a9c36f2e5d4c3b2a19087e6d5c4b3a291807'),
    notes: 'A container image digest body, minus the `sha256:` prefix so the prefix is not what saves it.',
  },
  {
    id: 'e6-benign-asset-data-uri',
    kind: 'minified_asset',
    value:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    digest: digestOf(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ),
    notes: 'A 1×1 PNG as a data URI. A real one, so the false-positive set contains a string that is genuinely ' +
      'inert rather than a plausible-looking invention.',
  },
  {
    id: 'e6-benign-asset-chunk',
    kind: 'minified_asset',
    value: 'dist/assets/vendor.8c41d90b2e5f7a13.min.js',
    digest: digestOf('dist/assets/vendor.8c41d90b2e5f7a13.min.js'),
    notes: 'A content-hashed bundle path. The interesting part is the `filename` insertion point, where a ' +
      'content hash is the *only* thing in the string.',
  },
  {
    id: 'e6-benign-asset-font',
    kind: 'minified_asset',
    value: 'data:font/woff2;base64,d09GMgABAAAAAAKUAA0AAAAABmAAAAI9AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    digest: digestOf('data:font/woff2;base64,d09GMgABAAAAAAKUAA0AAAAABmAAAAI9AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    notes:
      'A font data URI, padded with a long run of `A`s. Low entropy over a long span — the case a ' +
      'fixed-character-set entropy score handles and a token-length heuristic does not.',
  },
  {
    id: 'e6-benign-git-sha-head',
    kind: 'git_sha',
    value: '4f2a1b9c7d3e8065a1f4c9b2e7d5a3c8f1e6b4d2',
    digest: digestOf('4f2a1b9c7d3e8065a1f4c9b2e7d5a3c8f1e6b4d2'),
    notes: 'A 40-hex commit id. Zero-purposeless entropy and it is still a 40-character opaque token.',
  },
  {
    id: 'e6-benign-git-sha-merge',
    kind: 'git_sha',
    value: '8c41d90b2e5f7a13b6c0d2e4f8a1b3c5d7e9f0a2',
    digest: digestOf('8c41d90b2e5f7a13b6c0d2e4f8a1b3c5d7e9f0a2'),
    notes: 'A merge commit id, same shape as the last one.',
  },
  {
    id: 'e6-benign-git-sha-tag',
    kind: 'git_sha',
    value: 'e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3',
    digest: digestOf('e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3'),
    notes:
      'A tagged commit id, and the one a redaction is most tempted to redact: a version tag is a name a ' +
      'developer reads out loud in a commit message, and a 40-character opaque token in a push notification ' +
      'looks exactly like a credential until somebody checks.',
  },
  {
    id: 'e6-benign-output-test-failure',
    kind: 'ordinary_output',
    value:
      'FAIL test/settle/partial-refund.spec.ts\n' +
      "    x settles an order that was partially refunded (2412 ms)\n" +
      '      expect(received).toBe(expected)\n' +
      '      Expected: "captured"\n' +
      '      Received: "pending"\n' +
      '    at Object.<anonymous> (test/settle/partial-refund.spec.ts:118:31)',
    digest: digestOf(
      'FAIL test/settle/partial-refund.spec.ts\n' +
        "    x settles an order that was partially refunded (2412 ms)\n" +
        '      expect(received).toBe(expected)\n' +
        '      Expected: "captured"\n' +
        '      Received: "pending"\n' +
        '    at Object.<anonymous> (test/settle/partial-refund.spec.ts:118:31)',
    ),
    notes:
      'A real test failure. Contains the word `Received` and a file path, both of which a keyword redactor ' +
      'has to survive.',
  },
  {
    id: 'e6-benign-output-diff',
    kind: 'ordinary_output',
    value:
      'diff --git a/src/checkout/settle.ts b/src/checkout/settle.ts\n' +
      'index 8f41d90..b2e5f7a 100644\n' +
      '@@ -118,7 +118,7 @@ export async function settlePartialRefund(order: Order) {\n' +
      '-  const captured = await payments.capture(order.authorization);\n' +
      '+  const captured = await payments.capture(order.authorization, { idempotent: true });',
    digest: digestOf(
      'diff --git a/src/checkout/settle.ts b/src/checkout/settle.ts\n' +
        'index 8f41d90..b2e5f7a 100644\n' +
        '@@ -118,7 +118,7 @@ export async function settlePartialRefund(order: Order) {\n' +
        '-  const captured = await payments.capture(order.authorization);\n' +
        '+  const captured = await payments.capture(order.authorization, { idempotent: true });',
    ),
    notes:
      'A unified diff, whose `index 8f41d90..b2e5f7a` line is two git abbreviations and whose `@@` hunk header ' +
      'is a dense run of punctuation an entropy scorer has to be told is not a token.',
  },
  {
    id: 'e6-benign-output-env-example',
    kind: 'ordinary_output',
    value:
      '# copy to .env and fill in\n' +
      'DATABASE_URL=${DATABASE_URL}\n' +
      'API_KEY=<your-api-key>\n' +
      'SESSION_SECRET=changeme',
    digest: digestOf(
      '# copy to .env and fill in\n' +
        'DATABASE_URL=${DATABASE_URL}\n' +
        'API_KEY=<your-api-key>\n' +
        'SESSION_SECRET=changeme',
    ),
    notes:
      'An `.env.example`, and the sharpest control in the set: every line of it looks like an assignment to ' +
      'a secret-shaped keyword and none of it is a credential. This is the entry that decides whether the ' +
      'redactor has a `rejectValue` brake, and `SESSION_SECRET=changeme` is precisely the documented example ' +
      'in `isDocPlaceholderValue`.',
  },
]);

// ------------------------------------------------------------- the carriers

/**
 * One carrier template per insertion point.
 *
 * §E6 names the seven points; this is what each one looks like when a coding
 * agent's output is captured. The shape of the carrier matters as much as the
 * secret does, because a redaction policy is written against carriers: a rule
 * that reads `password: "…"` out of a stack frame will not read
 * `"password": "…"` out of a JSON body, and the second is the more common of the
 * two in a modern tool result.
 *
 * `value` appears in every template, and in `tool_result` it appears **twice** —
 * once under a neutral key and once under a header — so a redactor that handles
 * only the first occurrence of a shape passes a single-occurrence suite and
 * fails this one.
 */
export const E6_CARRIERS: Readonly<Record<E6InsertionPointName, (value: string) => string>> =
  Object.freeze({
    tool_result: (value: string): string =>
      '{"ok":false,"status":"error","error":"upstream rejected the request","attempt":3,' +
      '"request":{"method":"POST","url":"https://api.internal.example/v1/session",' +
      `"credential":"${value}","headers":{"x-api-key":"${value}"}}}`,
    file_read: (value: string): string =>
      `$ cat deploy/.env.production\nAPP_ENV=production\nLOG_LEVEL=info\n${value}\nSESSION_TTL=3600\n$ `,
    agent_prose: (value: string): string =>
      `I read deploy/.env.production and the value is ${value}. I will pass ${value} to the health check ` +
      'so it stops returning 401.',
    error_trace: (value: string): string =>
      'TypeError: fetch failed\n' +
      '    at Client.request (node:internal/deps/undici/undici.js:12345:11)\n' +
      '    at async loadConfig (/srv/gateway/src/config.ts:88:20)\n' +
      '  cause: ConnectionError: connect ECONNREFUSED 10.4.0.9:5432\n' +
      `  config: { url: "${value}" }`,
    commit_message: (value: string): string =>
      'fix(gateway): allow health check to reach staging\n\n' +
      'The check was returning 401 because the client was built with\n' +
      `url=${value}\nwhich the staging gateway rejects for direct database access.`,
    // A secret embedded in a *path* is the case where redaction has to rewrite
    // something that is not prose at all, and where forgetting to do so writes a
    // credential into a directory name that is then uploaded to an artifact store.
    filename: (value: string): string => `var/log/strata/${value}/session.jsonl`,
    // §E6 bolds this one: "**and the agent's own output**". The model echoing a
    // secret into its answer is how it reaches a gist, and no redaction applied
    // to tool output can prevent it.
    agent_output: (value: string): string =>
      `{"answer":"The staging gateway expects the credential ${value}; that is why the check returned 401.",` +
      '"confidence":"high","toolCalls":1}',
  });

/** The carrier text for one value at one insertion point. */
export const renderE6Carrier = (
  insertionPoint: E6InsertionPointName,
  value: string,
): string => E6_CARRIERS[insertionPoint](value);

// --------------------------------------------------------- the injected codec

/**
 * The four redactor modes, as `packages/security/src/redact.ts` names them.
 *
 * `off` rewrites nothing and reports nothing. `log` reports and rewrites nothing,
 * which is the mode a deployment uses to measure its own false-positive rate
 * before trusting the rewriting — and it is why this suite binds a redactor for
 * `control+` rather than reusing `control`. `placeholder` reports and rewrites.
 * `block` reports, rewrites, and refuses to hand anything on.
 */
export type E6RedactionMode = 'off' | 'log' | 'placeholder' | 'block';

/** One redaction finding. Telemetry-shaped: no value, no offsets, only a digest. */
export interface E6RedactorFinding {
  readonly ruleId: string;
  readonly kind: E6SecretKind;
  readonly confidence: 'certain' | 'probable' | 'possible';
  readonly length: number;
  readonly digest: string;
}

/**
 * What a redactor did to one string.
 *
 * `blocked` is a separate boolean rather than a fifth mode because "I refused
 * this" and "here is the text" are different answers, and a redactor that
 * reports `blocked: true` alongside a non-empty `text` is claiming both. The
 * pipeline treats that combination as a bug in the redactor and throws, because
 * the alternative is to forward bytes a redactor has already said must not be
 * forwarded.
 */
export interface E6RedactionOutcome {
  readonly text: string;
  readonly changed: boolean;
  readonly blocked: boolean;
  readonly findings: readonly E6RedactorFinding[];
}

/**
 * The subject under test.
 *
 * Injected, never imported, for the same reason E1's compaction strategy is
 * (`runE1Suite` has no default): this package has no dependencies and no
 * project reference (AGENTS.md §12.1), and the *thing being measured* is
 * behaviour, not a function call this file could make. The offline tests supply
 * a shape-based fake; F2 supplies `RedactionEngine` from
 * `@strata-ctx/security`. Nothing here can tell the difference, which is
 * exactly what lets the apparatus be tested against a redactor that measurably
 * fails.
 */
export interface E6Redactor {
  readonly mode: E6RedactionMode;
  redact(text: string): E6RedactionOutcome;
}

/**
 * The three arm configurations, as literals rather than as a convention.
 *
 * The arm *is* the redactor mode in this suite, and a mapping a caller could get
 * wrong would be a mapping that could put `off` on the treatment arm — which
 * scores a perfect 100% recall while shipping a product that redacts nothing.
 * Hence the table is data, and `assertE6Binding` checks the bound redactor's own
 * `mode` against the row it was bound to.
 */
export const E6_ARM_MODES: Readonly<Record<Arm, E6RedactionMode>> = Object.freeze({
  control: 'off',
  'control+': 'log',
  treatment: 'placeholder',
});

/** The mode an arm is supposed to be running. See `E6_ARM_MODES`. */
export const e6ModeForArm = (arm: Arm): E6RedactionMode => E6_ARM_MODES[arm];

/**
 * Everything the suite needs to measure a redaction pipeline, in one value.
 *
 * `productionCodec` is the honesty switch, and it is the reason the whole gate
 * can be refused. A binding that says `false` is a fake, and a fake that scores
 * 100% recall has measured the fake. So `evaluateE6Gates` returns `inconclusive`
 * for G9 whenever this is false, no matter how clean the rest of the run is.
 *
 * `blockRedactor` is bound separately rather than smuggled in as a fourth arm
 * because `block` is not an experimental configuration — it is an assertion
 * §E6 makes about the shipping code, and giving it an arm would let a run report
 * G9 without ever touching the behaviour the assertion is about.
 */
export interface E6RedactorBinding {
  /** Named in the provenance. A report that cannot name what it measured is not evidence. */
  readonly id: string;
  /** True only for `@strata-ctx/security`'s `RedactionEngine`. See the module header. */
  readonly productionCodec: boolean;
  readonly redactors: Readonly<Record<Arm, E6Redactor>>;
  readonly blockRedactor: E6Redactor;
}

/** A missing or mis-bound redactor, refused before any arm runs. */
export class E6BindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E6BindingError';
  }
}

/**
 * Check a binding, or refuse to run.
 *
 * Three checks, each catching a way the suite could produce a green number that
 * means nothing:
 *
 * - every arm bound, and each bound redactor's own `mode` equal to the mode that
 *   arm is supposed to be (`control` → `off`, `control+` → `log`, `treatment` →
 *   `placeholder`). A binding that points `treatment` at an `off` redactor is
 *   the cheapest available way to fake a 100% recall, and it is a plausible
 *   wiring mistake rather than a lie.
 * - `blockRedactor.mode === 'block'`, for the same reason.
 * - `id` non-empty, so provenance can name it.
 */
export const assertE6Binding = (binding: E6RedactorBinding): void => {
  if (typeof binding.id !== 'string' || binding.id.trim() === '') {
    throw new E6BindingError(
      'e6: a redactor binding needs an id. A report that cannot name what it measured is not evidence.',
    );
  }
  if (typeof binding.productionCodec !== 'boolean') {
    throw new E6BindingError('e6: productionCodec must be a boolean; the gate reads it to decide G9');
  }
  for (const arm of E6_ARMS) {
    const redactor = binding.redactors[arm];
    if (redactor === undefined || typeof redactor.redact !== 'function') {
      throw new E6BindingError(
        `e6: no redactor bound for the "${arm}" arm. There is no default from which a green report could ` +
          'be obtained by forgetting to configure the thing under test.',
      );
    }
    const expected = E6_ARM_MODES[arm];
    if (redactor.mode !== expected) {
      throw new E6BindingError(
        `e6: the "${arm}" arm is bound to a redactor in "${redactor.mode}" mode, but that arm is ` +
          `"${expected}" mode by definition (E6_ARM_MODES). Binding the wrong mode to an arm scores a ` +
          'number that describes neither the arm nor the product.',
      );
    }
  }
  if (binding.blockRedactor === undefined || binding.blockRedactor.mode !== 'block') {
    throw new E6BindingError(
      'e6: blockRedactor must be bound in "block" mode. §E6 asserts that a blocked tool result is not ' +
        'forwarded at all, and an unblocked redactor cannot falsify that assertion.',
    );
  }
};

// ------------------------------------------------------------- durable sinks

/** One field, as it reaches a durable sink: which insertion point, and its bytes. */
export interface E6SinkField {
  readonly insertionPoint: E6InsertionPointName;
  readonly text: string;
}

/**
 * One write, with the bytes the writer receives.
 *
 * `content` is built by the *caller*, not the writer, because a writer cannot
 * invent bytes: a real gist serialises what it is given. `content` is therefore
 * the artefact the leak audit scans, and it is generated from `fields` by
 * `renderE6WriteContent` alone so the two cannot drift.
 *
 * `runId` correlates a write with the observation that caused it, and it is not
 * optional bookkeeping. The writers are long-lived: the same six instances serve
 * all three arms and all eight cases, so a writer's log is a *cumulative* record
 * of everything the suite has ever pushed at it. Grading a leak by scanning that
 * log would mean the `control` arm's deliberate leaks are still sitting in it
 * when the `treatment` arm is graded, and every sink would be reported as leaking
 * in the arm that redacted. Correlating on the run is also what a real telemetry
 * writer wants: it is the join key between a durable record and the observation
 * that produced it, and it is the only thing that makes "this case reached this
 * writer" a checkable claim rather than a hopeful one.
 */
export interface E6SinkWrite {
  readonly writer: E6WriterName;
  readonly category: E6SinkCategory;
  /** `<arm>:<caseId>` — identifies the observation this write came from. */
  readonly runId: string;
  readonly content: string;
  readonly fields: readonly E6SinkField[];
}

/**
 * A durable destination.
 *
 * `written()` rather than a public array, and it is a copy: the audit needs to
 * read what a sink holds *after* the run, and a harness that handed out the
 * live array would let a test mutate the evidence it is about to grade.
 */
export interface E6SinkWriter {
  readonly name: E6WriterName;
  write(write: E6SinkWrite): void;
  written(): readonly E6SinkWrite[];
}

/**
 * Whether a sink's *stored bytes* hold a secret.
 *
 * `content.includes(span)` on its own is not containment. `renderE6WriteContent`
 * hands the `artifact_store` and all three `telemetry` writers a JSON document,
 * and `JSON.stringify` rewrites a newline as the two characters `\` and `n` — so
 * a PEM block, the longest value in the corpus and the one a reader would most
 * want to see caught, is present in those three sinks in full and reports zero
 * leaks under a literal scan. The audit would call a sink clean for holding the
 * one secret it re-encoded rather than dropped, which is the specific failure
 * mode §E6's "durable sink" language exists to prevent.
 *
 * Both spellings are therefore searched: the span as written, and the body of its
 * JSON string literal. `JSON.stringify` builds the second one so the two cannot
 * drift — a hand-written escape table would eventually miss `\u0000`.
 */
export const e6StoredBytesHold = (content: string, span: string): boolean => {
  if (span === '') return false;
  if (content.includes(span)) return true;
  const escaped = JSON.stringify(span).slice(1, -1);
  return escaped !== span && content.includes(escaped);
};

/**
 * How each category serialises a capture.
 *
 * The four are genuinely different formats, not four names for the same blob,
 * because a redaction is only as good as the format it has to survive. A gist is
 * prose, so a rewritten path or an unrewritten `password=` line reads the same
 * either way; a `ctx_status` line is a single key/value pair per insertion
 * point, so a secret in a *filename* ends up in a field a status command prints
 * with no other decoration around it; a telemetry line is JSON, so a secret in a
 * commit message becomes an escaped JSON string rather than a paragraph. A
 * redactor that only handles one of these is three-quarters broken.
 */
export const renderE6WriteContent = (
  category: E6SinkCategory,
  fields: readonly E6SinkField[],
): string => {
  switch (category) {
    case 'gist':
      return `# session capture\n\n${fields
        .map((field) => `## ${field.insertionPoint}\n\n${field.text}`)
        .join('\n\n')}\n`;
    case 'artifact_store':
      return `${JSON.stringify(
        {
          artifact: 'ctx-session-capture',
          v: 1,
          fields: fields.map((field) => ({ at: field.insertionPoint, text: field.text })),
        },
        null,
        2,
      )}\n`;
    case 'telemetry':
      return `${fields
        .map((field) => JSON.stringify({ event: 'ctx.capture', at: field.insertionPoint, text: field.text }))
        .join('\n')}\n`;
    case 'ctx_status':
      return `${fields.map((field) => `${field.insertionPoint}: ${field.text}`).join('\n')}\n`;
  }
};

/**
 * A writer that keeps what it is handed, in memory.
 *
 * The offline stand-in for a gist, an artifact store, a telemetry sink and a
 * status line. It applies **no** persistence gate, and that is deliberate and
 * load-bearing: production's `assertPersistable` refuses a write containing a
 * certain-confidence secret whatever the mode says, and if the reference writers
 * did that here the `control` and `control+` arms could not leak, the negative
 * control could not fire, and this suite would end up measuring the sink instead
 * of the redaction. `TODO(WS-F, F2)` binds the real writers, which have the gate,
 * and re-runs G9 against them.
 */
export const createE6RecordingWriter = (name: E6WriterName): E6SinkWriter => {
  const writes: E6SinkWrite[] = [];
  return {
    name,
    write(write: E6SinkWrite): void {
      writes.push(write);
    },
    written(): readonly E6SinkWrite[] {
      return Object.freeze([...writes]);
    },
  };
};

/**
 * A fan-out writer.
 *
 * §E6 says *any* telemetry sink, and the reason to have a tee rather than two
 * independent sinks is that a fan-out is a place a policy gets applied on the way
 * in and lost on the way out to a second leaf: the first leaf can be redacted,
 * the second written straight through, and a report that inspected only the tee
 * would see the first leaf's clean result. So `written()` returns the **union of
 * the leaves' contents**, not the writes the tee itself was handed, and the test
 * asserts the leaves are non-empty — a tee wired to nothing is a pass that costs
 * nothing to obtain.
 */
export const createE6TeeWriter = (
  name: E6WriterName,
  leaves: readonly E6SinkWriter[],
): E6SinkWriter => {
  if (leaves.length === 0) {
    throw new E6BindingError('e6: a tee writer needs at least one leaf; a tee to nothing is not a fan-out');
  }
  return {
    name,
    write(write: E6SinkWrite): void {
      for (const leaf of leaves) leaf.write(write);
    },
    written(): readonly E6SinkWrite[] {
      return Object.freeze(leaves.flatMap((leaf) => leaf.written()));
    },
  };
};

/** The six reference writers, wired exactly as `E6_WRITER_CATEGORIES` says. */
export const createE6ReferenceWriters = (): readonly E6SinkWriter[] => {
  const memory = createE6RecordingWriter('telemetry.memory');
  const jsonl = createE6RecordingWriter('telemetry.jsonl');
  return Object.freeze([
    createE6RecordingWriter('gist'),
    createE6RecordingWriter('artifact_store'),
    memory,
    jsonl,
    createE6TeeWriter('telemetry.tee', [memory, jsonl]),
    createE6RecordingWriter('ctx_status'),
  ]);
};

// -------------------------------------------------------- applying a redactor

/** One field, after the redactor has seen it. Never leaves this module verbatim. */
export interface E6AppliedField {
  readonly insertionPoint: E6InsertionPointName;
  /**
   * The bytes offered to the durable writers, or `null` when the write must be
   * refused outright.
   */
  readonly durableText: string | null;
  /** What the model sees. See the fail-open note on `applyE6Redaction`. */
  readonly forwarded: string;
  readonly blocked: boolean;
  readonly findings: readonly E6RedactorFinding[];
  readonly redactorError: string | null;
}

/** A redactor that broke, or claimed to block while still handing over bytes. */
export class E6RedactorError extends Error {
  readonly insertionPoint: E6InsertionPointName;

  constructor(insertionPoint: E6InsertionPointName, message: string) {
    super(message);
    this.name = 'E6RedactorError';
    this.insertionPoint = insertionPoint;
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Apply one redactor to one field.
 *
 * Three behaviours, each of which is a decision rather than an implementation
 * detail:
 *
 * 1. **`block` forwards nothing.** §E6: "in `block` mode a redacted tool result
 *    is not forwarded to the model at all". Read per *field* rather than per
 *    result, and the reading is argued in the test that exercises it: a
 *    tool_result carries a secret-bearing line and a benign line, forwarding the
 *    benign line is what proves the block was targeted rather than a blanket
 *    truncation, and a blanket truncation would satisfy the assertion while
 *    leaving the agent unable to work.
 * 2. **A redactor error fails open for the model and closed for disk.** Losing a
 *    user's context to a redactor bug is catastrophic; writing a credential to a
 *    file the user believes is local costs the product's central claim (spec N4).
 *    `packages/security/src/redact.ts` draws the same line for the same reasons,
 *    so the two are consistent rather than merely similar.
 * 3. **`blocked: true` with non-empty text is refused, not used.** A redactor
 *    that says "refused" and then hands over bytes is a redactor whose two
 *    answers disagree, and the disagreement is in the direction that leaks. It
 *    throws rather than picking a winner, because a suite that quietly picks one
 *    is a suite whose verdict depends on which way the bug goes.
 */
export const applyE6Redaction = (redactor: E6Redactor, field: E6SinkField): E6AppliedField => {
  let outcome: E6RedactionOutcome;
  try {
    outcome = redactor.redact(field.text);
  } catch (error) {
    return {
      insertionPoint: field.insertionPoint,
      durableText: null,
      forwarded: field.text,
      blocked: false,
      findings: [],
      redactorError: errorText(error),
    };
  }

  if (typeof outcome.text !== 'string' || !Array.isArray(outcome.findings)) {
    throw new E6RedactorError(
      field.insertionPoint,
      `e6: the redactor returned a malformed outcome for the "${field.insertionPoint}" field`,
    );
  }

  if (outcome.blocked) {
    if (outcome.text !== '') {
      throw new E6RedactorError(
        field.insertionPoint,
        `e6: the redactor blocked the "${field.insertionPoint}" field and still returned ` +
          `${outcome.text.length} character(s) of text. Blocked means forwarded to nothing; a redactor ` +
          'that claims both has two answers and the one that leaks is the one being ignored.',
      );
    }
    return {
      insertionPoint: field.insertionPoint,
      durableText: null,
      forwarded: '',
      blocked: true,
      findings: outcome.findings,
      redactorError: null,
    };
  }

  return {
    insertionPoint: field.insertionPoint,
    durableText: outcome.text,
    forwarded: outcome.text,
    blocked: false,
    findings: outcome.findings,
    redactorError: null,
  };
};

// ------------------------------------------------------------- corpus linting

/** Every way the corpus can be a corpus that measures nothing. */
export type E6CorpusIssueCode =
  | 'missing_kind'
  | 'under_represented_kind'
  | 'duplicate_id'
  | 'duplicate_value'
  | 'empty_value'
  | 'undersized_secret'
  | 'span_outside_value'
  | 'span_not_planted'
  | 'digest_mismatch'
  | 'benign_carries_secret'
  | 'secret_carries_benign'
  | 'benign_not_planted'
  | 'missing_benign_kind'
  | 'no_notes';

export interface E6CorpusIssue {
  /** The entry id, or the kind name for a corpus-level issue. */
  readonly subject: string;
  readonly code: E6CorpusIssueCode;
  readonly message: string;
}

/** Entries per secret kind. Three, so no kind's rate is decided by one string. */
export const E6_MINIMUM_ENTRIES_PER_SECRET_KIND = 3;

/**
 * Can this corpus detect its own secrets?
 *
 * docs/evaluation.md §E6 asks for recall "on the corpus", which means the corpus
 * *is* the denominator — so a corpus that quietly shrinks, that plants a secret
 * in six of seven carriers, or that contains a benign entry carrying a real
 * secret value changes the number without changing a line of the product. These
 * are the checks that stop that, and `buildE6Fixture` refuses to build with any
 * of them outstanding.
 *
 * The two that catch the nastiest mistakes:
 *
 * - `span_not_planted` — a carrier the secret never reached. Recall would be
 *   computed over 7 insertion points while only 6 were ever offered, and the
 *   missing one would show up as a pass. A green suite that was never asked the
 *   question is the failure this whole package exists to prevent.
 * - `benign_carries_secret` — a benign control whose text contains a secret
 *   value. This is the one that would quietly *suppress* a leak: the control
 *   would be counted as a false positive, the redactor would be penalised for
 *   catching a secret, and a run in which every secret leaked would still show a
 *   100% recall because the detector is "eager". Both directions of the FP count
 *   are checked, because a false-positive rate computed against a contaminated
 *   control set is not a false-positive rate.
 */
export const lintE6Corpus = (
  secrets: readonly E6Secret[] = E6_SECRET_CORPUS,
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): readonly E6CorpusIssue[] => {
  const issues: E6CorpusIssue[] = [];
  const add = (subject: string, code: E6CorpusIssueCode, message: string): void => {
    issues.push({ subject, code, message });
  };

  const byKind = new Map<E6SecretKind, E6Secret[]>();
  for (const secret of secrets) {
    const bucket = byKind.get(secret.kind);
    if (bucket === undefined) byKind.set(secret.kind, [secret]);
    else bucket.push(secret);
  }
  for (const kind of E6_SECRET_KINDS) {
    const count = byKind.get(kind)?.length ?? 0;
    if (count === 0) {
      add(
        kind,
        'missing_kind',
        'the corpus has no entry of this kind. docs/evaluation.md §E6 names it, and a recall percentage ' +
          'over a corpus that omits a credential class is a percentage of the wrong denominator.',
      );
    } else if (count < E6_MINIMUM_ENTRIES_PER_SECRET_KIND) {
      add(
        kind,
        'under_represented_kind',
        `the corpus has ${count} entry/entries of this kind and the floor is ` +
          `${E6_MINIMUM_ENTRIES_PER_SECRET_KIND}; a kind represented by one string is decided by that string`,
      );
    }
  }
  for (const kind of E6_BENIGN_KINDS) {
    if (!benign.some((entry) => entry.kind === kind)) {
      add(
        kind,
        'missing_benign_kind',
        'the benign set has no entry of this kind. §E6 asks for a false-positive rate, and a rate over a ' +
          'control set that omits the shape entropy scoring loves is not a rate an operator can act on.',
      );
    }
  }

  const ids = new Set<string>();
  const values = new Set<string>();
  for (const secret of secrets) {
    if (ids.has(secret.id)) {
      add(secret.id, 'duplicate_id', 'reuses an id; the report attributes every finding by id');
    }
    ids.add(secret.id);
    if (values.has(secret.value)) {
      add(secret.id, 'duplicate_value', 'reuses a value; two ids for one string halves the corpus for nothing');
    }
    values.add(secret.value);

    if (secret.value === '' || secret.secretSpan === '') {
      add(secret.id, 'empty_value', 'has an empty value or span, so there is nothing to detect');
      continue;
    }
    if (secret.notes.trim() === '') {
      add(
        secret.id,
        'no_notes',
        'carries no note. §E6 publishes the corpus so others can run it, and every entry here is ' +
          'credential-shaped and therefore has to say in the file that it is inert.',
      );
    }
    if (secret.secretSpan.length < E6_MINIMUM_SECRET_LENGTH) {
      add(
        secret.id,
        'undersized_secret',
        `its span is ${secret.secretSpan.length} character(s) and the floor is ` +
          `${E6_MINIMUM_SECRET_LENGTH}; below that a "leak" is a substring collision, not a disclosure`,
      );
    }
    if (!secret.value.includes(secret.secretSpan)) {
      add(
        secret.id,
        'span_outside_value',
        'its span is not inside its own value, so the span could never be planted in a carrier',
      );
    }
    for (const point of E6_INSERTION_POINT_NAMES) {
      if (renderE6Carrier(point, secret.value).includes(secret.secretSpan)) continue;
      add(
        secret.id,
        'span_not_planted',
        `the "${point}" carrier does not contain its span. Recall would be computed over an insertion ` +
          'point the secret never reached, and the missing one would read as a pass.',
      );
    }
    if (secret.digest !== digestOf(secret.value)) {
      add(
        secret.id,
        'digest_mismatch',
        'its digest is not sha256(value). The digest is how an operator confirms a match locally, and a ' +
          'wrong one sends them looking for a credential that is not this one.',
      );
    }
  }

  for (const control of benign) {
    if (control.value === '') {
      add(control.id, 'empty_value', 'is empty, so it tests nothing');
      continue;
    }
    if (control.notes.trim() === '') {
      add(control.id, 'no_notes', 'carries no note; see the secret-side rule for why every entry must');
    }
    for (const secret of secrets) {
      if (secret.secretSpan !== '' && control.value.includes(secret.secretSpan)) {
        add(
          control.id,
          'benign_carries_secret',
          `its text contains the span of ${secret.id}. A "benign" control carrying a secret is counted as ` +
            'a false positive, which penalises a redactor for catching a credential and can show a run in ' +
            'which every secret leaked with a perfect recall.',
        );
        break;
      }
    }
    if (!E6_INSERTION_POINT_NAMES.every((point) => renderE6Carrier(point, control.value).includes(control.value))) {
      add(control.id, 'benign_not_planted', 'one of its carriers does not contain its own value');
    }
  }
  for (const secret of secrets) {
    for (const control of benign) {
      if (control.value !== '' && secret.value.includes(control.value)) {
        add(
          secret.id,
          'secret_carries_benign',
          `its value contains the benign control ${control.id}, so a leak of this secret is ` +
            'indistinguishable from a false positive on that control',
        );
        break;
      }
    }
  }

  return Object.freeze(issues);
};

// --------------------------------------------------------- fixture assembly

/** The eight cases, one per secret kind. */
export const E6_CASES: readonly E6SecretKind[] = Object.freeze<E6SecretKind[]>([...E6_SECRET_KINDS]);

/**
 * The fields one case offers: the secret at all seven insertion points, plus one
 * benign control.
 *
 * The control is not padding. It is what makes the `block` assertion
 * non-vacuous — a block that drops the whole tool result would also pass a test
 * that never checks anything arrived — and it is a second, cheaper trip through
 * the false-positive path on every case. It is drawn with a stride of two across
 * the benign corpus so the eight cases between them offer every benign *kind*,
 * including the two `ordinary_output` controls that decide whether the redactor
 * has a `rejectValue` brake.
 */
export const buildE6CaseFields = (
  secret: E6Secret,
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): readonly E6SinkField[] => {
  const index = E6_CASES.indexOf(secret.kind);
  const control = benign[((Math.max(0, index) * 2) % benign.length + benign.length) % benign.length];
  const controlField: E6SinkField[] =
    control === undefined
      ? []
      : [{ insertionPoint: 'tool_result', text: renderE6Carrier('tool_result', control.value) }];
  return Object.freeze([
    ...E6_INSERTION_POINT_NAMES.map(
      (point): E6SinkField => ({ insertionPoint: point, text: renderE6Carrier(point, secret.value) }),
    ),
    ...controlField,
  ]);
};

/** The raw fixture document, before validation. JSON-shaped on purpose. */
export type E6Document = Record<string, unknown>;

/**
 * The rendered session, as the stage would receive it.
 *
 * Every field is labelled with the insertion point it came from, because that is
 * what the *fixture* is for: `checkE6Rules` re-derives the carriers from the
 * corpus and requires each of them to appear here, so a prompt that quietly lost
 * an insertion point is a build error rather than a smaller denominator.
 */
export const renderE6CasePrompt = (secret: E6Secret, fields: readonly E6SinkField[]): string => {
  const lines = [
    `# E6 capture — ${secret.kind}`,
    '',
    'The compression stage is about to capture this session. Everything below is raw text the agent',
    'produced or read, labelled with the insertion point it came from. Nothing here is sanitised yet.',
    '',
  ];
  for (const field of fields) {
    lines.push(`## ${field.insertionPoint}`);
    lines.push(field.text);
    lines.push('');
  }
  return lines.join('\n');
};

export const buildE6Document = (
  secrets: readonly E6Secret[] = E6_SECRET_CORPUS,
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): E6Document => {
  const cases = E6_CASES.flatMap((kind) => {
    const secret = secrets.find((candidate) => candidate.kind === kind);
    if (secret === undefined) return [];
    const fields = buildE6CaseFields(secret, benign);
    return [
      {
        id: `e6-${kind.replace(/_/g, '-')}`,
        title: `${kind}: the same secret at all seven insertion points`,
        arms: [...E6_ARMS],
        // Every E6 case is a negative-control case: the `control` (off) and
        // `control+` (log) arms both fail it in every run, and marking only some
        // would put cases in the report that quietly stop protecting the claim.
        negativeControl: true,
        prompt: renderE6CasePrompt(secret, fields),
        notes:
          `Synthetic ${kind} (${secret.id}). The value is inert and shaped like a credential so a redactor ` +
          'is actually exercised. Planted at all seven §E6 insertion points plus one benign control at ' +
          'tool_result.',
        constraints: E6_INSERTION_POINT_NAMES.map(
          (point) => ({
            id: `e6-${secret.kind}-${point.replace(/_/g, '-')}`,
            text: `A secret carried by the ${point} insertion point must not survive into any durable ` +
              'sink, and in block mode must not be forwarded to the model at all.',
            kind: 'hard_safety' as const,
            forbidden: [e6LeakMarker(secret.id, point)],
          }),
        ),
      },
    ];
  });

  return {
    evalSuiteFormatVersion: EVAL_FIXTURE_FORMAT_VERSION,
    suite: E6_SUITE_ID,
    name: E6_SUITE_NAME,
    description:
      'Secret redaction, ported from docs/evaluation.md E6. Each case plants one synthetic secret at all ' +
      'seven insertion points (tool result, file read, agent prose, error trace, commit message, filename, ' +
      'and the agent\'s own output) and offers it to every durable sink category: gist, artifact store, ' +
      `all ${E6_SINK_CATEGORIES.length} categories, telemetry bound as three concrete writers, and ` +
      'ctx_status. G9 is 100% recall, read on the shipping arm; the corpus is exported from this module ' +
      'because §E6 names it the source of truth. The redactor and the writers are injected — offline they ' +
      'are fakes, so G9 is reported inconclusive rather than passed.',
    cases,
  };
};

/** Every reason E6 can refuse a fixture, corpus problems included. */
export type E6IssueCode = FixtureIssueCode | E6CorpusIssueCode | E6RuleIssueCode;

export type E6RuleIssueCode =
  | 'missing_arm'
  | 'not_negative_control'
  | 'missing_insertion_point'
  | 'marker_in_prompt'
  | 'prompt_missing_span';

export interface E6Issue {
  readonly path: string;
  readonly code: E6IssueCode;
  readonly message: string;
}

/**
 * The review rules, in code.
 *
 * Each of these is a way the report could be correct-looking and wrong, so each
 * is refused at build time rather than asserted in a test nobody has to run:
 *
 * - all three arms on every case — without `control`/`control+` the leak is
 *   never reproduced, and a case whose negative control does not fire stops
 *   protecting every other number in the report;
 * - marked as negative controls, for the same reason;
 * - one constraint per insertion point, all seven — a case that declares six
 *   measures six and calls it seven;
 * - **no leak marker may appear in the prompt.** This is the anti-vacuity check
 *   that matters most: the marker `<<leak:…>>` is what the harness grades
 *   against, so a marker that is already in the prompt would be found in the
 *   arm's response in every arm, and every arm would fail for the same reason.
 *   The fixture would be green-looking and measure nothing.
 * - the prompt must actually contain the secret at each insertion point.
 */
export const checkE6Rules = (
  fixture: EvalFixture,
  secrets: readonly E6Secret[] = E6_SECRET_CORPUS,
): readonly E6Issue[] => {
  const issues: E6Issue[] = [];
  // Keyed by *case* id, which names a kind and not an entry, so the map has to
  // keep the first entry of each kind — the same one `buildE6Document` picks with
  // `secrets.find(...)`. A `Map` built by iterating the corpus and letting later
  // entries overwrite earlier ones resolves to the *last* entry of each kind, and
  // then every carrier check below compares the prompt against a secret the
  // prompt never contained: 56 build errors that all say the corpus is broken.
  const byId = new Map<string, E6Secret>();
  for (const secret of secrets) {
    const key = `e6-${secret.kind.replace(/_/g, '-')}`;
    if (!byId.has(key)) byId.set(key, secret);
  }

  fixture.cases.forEach((evalCase, caseIndex) => {
    const path = `cases[${caseIndex}]`;
    const secret = byId.get(evalCase.id);
    if (secret === undefined) {
      issues.push({
        path: `${path}.id`,
        code: 'prompt_missing_span',
        message: `no corpus entry declares the kind this case is named for, so nothing can be checked about it`,
      });
      return;
    }

    for (const arm of E6_ARMS) {
      if (!evalCase.arms.includes(arm)) {
        issues.push({
          path: `${path}.arms`,
          code: 'missing_arm',
          message:
            `does not run "${arm}". E6 needs all three: control (redaction off) and control+ (log) are the ` +
            'negative controls that prove the suite can see a leak at all, and treatment is what ships.',
        });
      }
    }
    if (!evalCase.negativeControl) {
      issues.push({
        path: `${path}.negativeControl`,
        code: 'not_negative_control',
        message:
          'is not marked as a negative control. Every E6 case leaks in its off and log arms, and a case that ' +
          'silently stops being one stops protecting the claim.',
      });
    }

    const constraintIds = new Set(evalCase.constraints.map((constraint) => constraint.id));
    for (const point of E6_INSERTION_POINT_NAMES) {
      const id = `e6-${secret.kind}-${point.replace(/_/g, '-')}`;
      if (!constraintIds.has(id)) {
        issues.push({
          path: `${path}.constraints`,
          code: 'missing_insertion_point',
          message:
            `declares no constraint for the "${point}" insertion point. §E6 lists seven and a suite that ` +
            'checks six reports a recall over six.',
        });
      }
    }

    for (const [constraintIndex, constraint] of evalCase.constraints.entries()) {
      if (evalCase.prompt.includes(constraint.forbidden[0] ?? '\u0000')) {
        issues.push({
          path: `${path}.constraints[${constraintIndex}].forbidden`,
          code: 'marker_in_prompt',
          message:
            `the leak marker is already in the prompt. The harness grades an arm by searching its response ` +
            'for this marker, so a marker in the prompt is found in every arm and every arm fails for a ' +
            'reason that has nothing to do with redaction.',
        });
      }
      for (const secretValue of secrets) {
        if (secretValue.value === '') continue;
        if (constraint.forbidden.some((marker) => marker.includes(secretValue.value))) {
          issues.push({
            path: `${path}.constraints[${constraintIndex}].forbidden`,
            code: 'marker_in_prompt',
            message: 'a forbidden marker contains a secret value; markers reach a committed report',
          });
        }
      }
    }

    for (const point of E6_INSERTION_POINT_NAMES) {
      const carrier = renderE6Carrier(point, secret.value);
      if (!evalCase.prompt.includes(carrier)) {
        issues.push({
          path: `${path}.prompt`,
          code: 'prompt_missing_span',
          message:
            `the prompt does not contain the secret planted at the "${point}" insertion point. The pipeline ` +
            'is handed the prompt, so an insertion point the prompt does not carry is an insertion point ' +
            'the redactor is never asked about.',
        });
      }
    }
  });

  return Object.freeze(issues);
};

export class E6FixtureError extends Error {
  readonly issues: readonly E6Issue[];

  constructor(issues: readonly E6Issue[]) {
    super(issues.map((issue) => (issue.path === '' ? issue.message : `${issue.path} ${issue.message}`)).join('; '));
    this.name = 'E6FixtureError';
    this.issues = issues;
  }
}

/** Every E6-specific problem in a fixture document, base validation included. */
export const validateE6Document = (input: unknown): readonly E6Issue[] => {
  const base = validateFixture(input);
  if (base.length > 0) return Object.freeze([...base]);
  return checkE6Rules(parseFixture(input));
};

/**
 * Build the fixture, or refuse.
 *
 * Three refusals, each a different kind of lie: a corpus that cannot detect its
 * own secrets, a document the base validator rejects, and a fixture that breaks
 * a review rule. A harness that will happily run a suite it knows it cannot
 * measure is worse than one that crashes, because the crash is visible.
 */
export function buildE6Fixture(
  secrets: readonly E6Secret[] = E6_SECRET_CORPUS,
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): EvalFixture {
  const corpus = lintE6Corpus(secrets, benign);
  if (corpus.length > 0) {
    throw new E6FixtureError(
      corpus.map((issue) => ({ path: issue.subject, code: issue.code, message: issue.message })),
    );
  }

  const document = buildE6Document(secrets, benign);
  const base = validateFixture(document);
  if (base.length > 0) throw new E6FixtureError([...base]);

  const rules = checkE6Rules(parseFixture(document), secrets);
  if (rules.length > 0) throw new E6FixtureError(rules);

  return parseFixture(document);
}

// ---------------------------------------------------------------- the pipeline

/**
 * What happened to one planted secret at one insertion point.
 *
 * Everything here is a count, a name, a boolean or a digest. No value, no byte
 * offset, no snippet — a record is something a report can be built from and
 * something safe to commit, and the text it was derived from is available from
 * the corpus if somebody needs to reproduce the run.
 */
export interface E6FieldRecord {
  readonly caseId: string;
  readonly arm: Arm;
  readonly secretId: string;
  readonly secretKind: E6SecretKind;
  readonly insertionPoint: E6InsertionPointName;
  /** `block` mode refused this field. */
  readonly blocked: boolean;
  /** Bytes the model received. Zero under `block`. */
  readonly forwardedBytes: number;
  /** The redactor's text differed from what it was given. */
  readonly redactedChanged: boolean;
  readonly findingRuleIds: readonly string[];
  readonly findingDigests: readonly string[];
  /** The secret reached neither the model nor any durable writer. */
  readonly contained: boolean;
  readonly leakedToModel: boolean;
  readonly leakedToWriters: readonly E6WriterName[];
  /** The whole write was withheld because *some* field was blocked or refused. */
  readonly writeRefused: boolean;
  readonly redactorError: string | null;
}

/** What happened to the benign control riding along in the same write. */
export interface E6ControlRecord {
  readonly caseId: string;
  readonly arm: Arm;
  readonly benignId: string;
  readonly benignKind: E6BenignKind;
  readonly blocked: boolean;
  /** The redactor changed the control's text: a false positive on this case. */
  readonly rewritten: boolean;
  readonly findingRuleIds: readonly string[];
  /** Non-zero proves the control actually reached the model, i.e. a pass is not a blank. */
  readonly forwardedBytes: number;
  /** Zero under `block`, which refuses the whole write. */
  readonly durableBytes: number;
}

/** One (case, arm) observation: seven planted secrets and one control. */
export interface E6RecordedCase {
  readonly caseId: string;
  readonly arm: Arm;
  readonly position: number;
  /** The corpus specimen this run planted. A case plants every specimen of its kind. */
  readonly secretId: string;
  /**
   * `<arm>:<caseId>:<secretId>` — carried rather than recomputed. The audit
   * re-reads what the writers stored, and it can only find those writes if it
   * builds the same id the writer was given; deriving the string in two places is
   * how an audit ends up reporting "no write found" for a write that happened.
   */
  readonly runId: string;
  readonly fields: readonly E6FieldRecord[];
  readonly control: E6ControlRecord | null;
  /** Writers that were offered a write. */
  readonly writersOffered: readonly E6WriterName[];
  /** Writers a write actually reached. Fewer than offered only if refused. */
  readonly writersWritten: readonly E6WriterName[];
  readonly writeRefused: boolean;
  /** The response the harness graded, so the audit can re-derive from it. */
  readonly response: string;
  readonly violatedConstraintIds: readonly string[];
}

/**
 * Run one case against one redactor, across every writer.
 *
 * The order of the three decisions inside the loop is the whole design:
 *
 * 1. **Every field is redacted first, all seven, before any writer is touched.**
 *    A pipeline that wrote as it went would already have stored the first three
 *    secrets by the time it reached the blocked one, and "we refused the write"
 *    would be a claim about a write that already happened.
 * 2. **A blocked or unredactable field refuses the entire write.** Not the field
 *    — the write. A gist is a single document; a gist with the credential line
 *    removed and the DSN left intact is still a gist that says "a credential was
 *    here, and here is the host", and a telemetry line with a field dropped is a
 *    line whose schema no longer matches the readers downstream of it. This is
 *    the same all-or-nothing rule `SecretBlockedError` implies in
 *    `packages/security/src/redact.ts`.
 * 3. **Leak detection is a re-scan of what the writers actually stored**, not a
 *    re-read of what the pipeline meant to write. The audit looks in
 *    `written()[].content` and hunts the secret's span, so a writer that
 *    transformed, truncated or reordered a payload on the way in is graded on
 *    what it kept. A pipeline grading its own intentions is a pipeline grading
 *    its own homework.
 */
export const runE6Case = (
  fixtureCase: EvalFixture['cases'][number],
  secret: E6Secret,
  arm: Arm,
  position: number,
  redactor: E6Redactor,
  writers: readonly E6SinkWriter[],
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): E6RecordedCase => {
  const fields = buildE6CaseFields(secret, benign);
  // `buildE6CaseFields` emits the seven planted insertion points first, in
  // `E6_INSERTION_POINT_NAMES` order, then the control. Positional indexing is
  // used rather than a `Map` keyed on `insertionPoint` because two fields here
  // share `tool_result` — the planted secret and the benign control — and a
  // key-on-insertion-point map silently keeps one of them, which would grade the
  // secret's `tool_result` on the control's redaction outcome. In `off` mode that
  // is not a small mistake: the control carries no secret, so the secret's
  // `tool_result` would come back "contained" in the arm whose entire job is to
  // leak.
  const plantedCount = E6_INSERTION_POINT_NAMES.length;
  const planted = fields.slice(0, plantedCount);
  const controlField = fields.length > plantedCount ? fields[plantedCount] : undefined;

  const applied = fields.map((field) => applyE6Redaction(redactor, field));
  const plantedApplied = applied.slice(0, plantedCount);

  const blocked = plantedApplied.some((entry) => entry.blocked);
  const refused = applied.some((entry) => entry.durableText === null);
  const writeRefused = blocked || refused;

  const runId = `${arm}:${fixtureCase.id}:${secret.id}`;
  const holds = (writer: E6SinkWriter, span: string): boolean =>
    writer.written().some((write) => write.runId === runId && e6StoredBytesHold(write.content, span));

  if (!writeRefused) {
    const durableFields = applied.map(
      (entry): E6SinkField => ({ insertionPoint: entry.insertionPoint, text: entry.durableText ?? '' }),
    );
    for (const writer of writers) {
      writer.write({
        writer: writer.name,
        category: E6_WRITER_CATEGORIES[writer.name],
        runId,
        content: renderE6WriteContent(E6_WRITER_CATEGORIES[writer.name], durableFields),
        fields: durableFields,
      });
    }
  }

  // Reached means "a write with this run's id exists", which is a fact about the
  // writer rather than an assumption that it accepted what it was handed.
  const writersWritten = writers
    .filter((writer) => writer.written().some((write) => write.runId === runId))
    .map((writer) => writer.name)
    .sort();

  const records: E6FieldRecord[] = planted.map((field, index) => {
    const entry = plantedApplied[index];
    if (entry === undefined) {
      throw new E6RedactorError(field.insertionPoint, 'e6: a planted field produced no redactor outcome');
    }
    const leakedToWriters = writeRefused
      ? []
      : writers
          .filter((writer) => holds(writer, secret.secretSpan))
          .map((writer) => writer.name)
          .sort();
    const leakedToModel = entry.forwarded.includes(secret.secretSpan);
    return {
      caseId: fixtureCase.id,
      arm,
      secretId: secret.id,
      secretKind: secret.kind,
      insertionPoint: field.insertionPoint,
      blocked: entry.blocked,
      forwardedBytes: entry.forwarded.length,
      redactedChanged: entry.durableText !== null && entry.durableText !== field.text,
      findingRuleIds: entry.findings.map((finding) => finding.ruleId).sort(),
      findingDigests: entry.findings.map((finding) => finding.digest).sort(),
      contained: !leakedToModel && leakedToWriters.length === 0,
      leakedToModel,
      leakedToWriters: Object.freeze([...leakedToWriters]),
      writeRefused,
      redactorError: entry.redactorError,
    };
  });

  const controlEntry = controlField === undefined ? undefined : applied[plantedCount];
  const control: E6ControlRecord | null =
    controlEntry === undefined || controlField === undefined
      ? null
      : {
          caseId: fixtureCase.id,
          arm,
          benignId: `control:${fixtureCase.id}`,
          benignKind: benignKindOf(controlField.text, benign),
          blocked: controlEntry.blocked,
          rewritten: controlEntry.durableText !== null && controlEntry.durableText !== controlField.text,
          findingRuleIds: controlEntry.findings.map((finding) => finding.ruleId).sort(),
          forwardedBytes: controlEntry.forwarded.length,
          durableBytes: writeRefused ? 0 : (controlEntry.durableText ?? '').length,
        };

  const response = renderE6Response(records, control, writers);
  const violatedConstraintIds = records
    .filter((record) => !record.contained)
    .map((record) => `e6-${secret.kind}-${record.insertionPoint.replace(/_/g, '-')}`)
    .sort();

  return Object.freeze({
    caseId: fixtureCase.id,
    arm,
    position,
    secretId: secret.id,
    runId,
    fields: Object.freeze(records),
    control,
    writersOffered: Object.freeze(writers.map((writer) => writer.name)),
    writersWritten: Object.freeze([...writersWritten]),
    writeRefused,
    response,
    violatedConstraintIds: Object.freeze(violatedConstraintIds),
  });
};

/**
 * The benign kind of a control carrier, recovered from the text.
 *
 * Recovered rather than carried alongside for the same reason `E6_SECRET_CORPUS`
 * is exported and not inlined in the tests: one definition, so the control a
 * case offers and the control the report names cannot be two different strings.
 * Matching on the carrier is unambiguous because each benign value appears in
 * exactly one corpus entry.
 *
 * An unmatched carrier is not a benign `ordinary_output` by default — that would
 * let a renamed or customised control be reported as prose and pass silently. It
 * throws, because the only way to reach this line with no match is a control that
 * the report cannot name, and a report that cannot name its own control is not a
 * report.
 */
export const benignKindOf = (carrierText: string, benign: readonly E6Benign[] = E6_BENIGN_CORPUS): E6BenignKind => {
  const hit = benign.find((entry) => carrierText.includes(entry.value));
  if (hit === undefined) {
    throw new Error(
      'e6: a control carrier matched no corpus entry, so the report could not name it. The control and the ' +
        'benign corpus have diverged.',
    );
  }
  return hit.kind;
};

/**
 * The evidence a case contributes to the report, as text.
 *
 * One line per planted secret. A leak is named by its safe marker plus the exact
 * destinations that held the secret — the model, one writer, or all of them —
 * because "a leak occurred" is not a finding anyone can act on and "it was in the
 * gist" is. This string is the arm's `response`, so the harness grades it
 * with the same substring machinery every other suite uses, and it is also what
 * `auditE6Run` re-derives from the writers independently.
 */
export const renderE6Response = (
  records: readonly E6FieldRecord[],
  control: E6ControlRecord | null,
  writers: readonly E6SinkWriter[],
): string => {
  const names = writers.map((writer) => writer.name);
  const lines = [`writers: ${names.join(', ')}`];
  for (const record of records) {
    const destinations = [...(record.leakedToModel ? ['model'] : []), ...record.leakedToWriters];
    if (record.blocked) {
      lines.push(
        `${record.insertionPoint}: blocked; forwarded ${record.forwardedBytes} byte(s); write refused` +
          (record.redactedChanged ? ' (a field was redacted before the refusal)' : ''),
      );
      continue;
    }
    if (destinations.length === 0) {
      lines.push(`${record.insertionPoint}: clean in the model and all ${names.length} writers`);
      continue;
    }
    lines.push(
      `${record.insertionPoint}: ${e6LeakMarker(record.secretId, record.insertionPoint)} in ` +
        `${destinations.join(', ')}`,
    );
  }
  if (control !== null) {
    lines.push(
      `benign control (${control.benignKind}): ${control.blocked ? 'blocked' : 'forwarded'} ` +
        `${control.forwardedBytes} byte(s), ${control.durableBytes} byte(s) durable` +
        (control.rewritten ? ' — REWRITTEN, false positive' : ''),
    );
  }
  return lines.join('\n');
};

// --------------------------------------------------------------- block probe

/** One planted secret seen by the `block` redactor. */
export interface E6BlockFieldRecord {
  readonly secretId: string;
  readonly secretKind: E6SecretKind;
  readonly insertionPoint: E6InsertionPointName;
  readonly blocked: boolean;
  readonly forwardedBytes: number;
  readonly writeRefused: boolean;
  readonly leakedToModel: boolean;
}

/**
 * The `block`-mode result.
 *
 * §E6's block assertion has two halves and they fail differently. "The redacted
 * tool result is not forwarded at all" is a claim about the model context, and a
 * pipeline that blanks everything satisfies it — including a pipeline that breaks
 * the agent by blanking everything. So the benign control riding in the same
 * write is counted here, as `controlsBlocked` and `controlsForwarded`, and a run
 * in which the control was *neither* blocked nor forwarded is a run where the
 * control vanished and the numbers above it should not be believed.
 *
 * Note that a control which is blocked is the *normal* outcome, not a failure: a
 * `block`-mode redactor refuses the whole tool result, and the benign line inside
 * it goes with it. Requiring the control to arrive would therefore assert that
 * block is a per-field redaction, which is a different (and weaker) product than
 * the one §E6 describes. The non-vacuity check that does matter — that a pass was
 * not bought by forwarding nothing — is made against the *shipping* arm instead,
 * where the control has to arrive.
 *
 * "No secret reaches a durable sink" is the other half, and it is checked by
 * re-scanning what the writers stored.
 */
export interface E6BlockReport {
  readonly redactorMode: E6RedactionMode;
  readonly observations: number;
  readonly blocked: number;
  readonly forwardedNothing: number;
  readonly writesRefused: number;
  readonly leaks: number;
  /** Benign controls in the same writes, and what became of each. */
  readonly controls: number;
  readonly controlsBlocked: number;
  readonly controlsForwarded: number;
  readonly complete: boolean;
  /** Safe markers for anything that was not blocked or did arrive. Empty if complete. */
  readonly offenders: readonly string[];
}

export const runE6BlockProbe = (
  fixture: EvalFixture,
  secrets: readonly E6Secret[] = E6_SECRET_CORPUS,
  binding?: E6RedactorBinding,
  writers: readonly E6SinkWriter[] = createE6ReferenceWriters(),
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): E6BlockReport => {
  const redactor = binding?.blockRedactor;
  if (redactor === undefined || redactor.mode !== 'block') {
    throw new E6BindingError(
      'e6: the block probe needs a redactor bound in "block" mode. §E6 asserts the behaviour of block, ' +
        'and a placeholder redactor cannot falsify it.',
    );
  }

  const fields: E6BlockFieldRecord[] = [];
  const offenders: string[] = [];
  let controls = 0;
  let controlsBlocked = 0;
  let controlsForwarded = 0;
  let controlsVanished = 0;
  let writesRefused = 0;

  // Every secret in the corpus, not one per kind. The fixture has one case per
  // kind, so iterating `fixture.cases` would probe a third of the corpus and call
  // it complete — and the kind it dropped would be whichever `find` happened to
  // return. §E6 asserts the behaviour of the shipping code, so the denominator
  // here is the same (secret, insertion point) unit the recall gate uses.
  const caseByKind = new Map(fixture.cases.map((evalCase) => [evalCase.id, evalCase]));

  for (const secret of secrets) {
    const fixtureCase = caseByKind.get(`e6-${secret.kind.replace(/_/g, '-')}`);
    if (fixtureCase === undefined) continue;
    const recorded = runE6Case(fixtureCase, secret, 'treatment', 0, redactor, writers, benign);
    if (recorded.writeRefused) writesRefused += 1;
    const control = recorded.control;
    if (control !== null) {
      controls += 1;
      if (control.blocked) controlsBlocked += 1;
      else if (control.forwardedBytes > 0) controlsForwarded += 1;
      else controlsVanished += 1;
    }
    for (const field of recorded.fields) {
      const leakedToModel = field.leakedToModel;
      fields.push({
        secretId: field.secretId,
        secretKind: field.secretKind,
        insertionPoint: field.insertionPoint,
        blocked: field.blocked,
        forwardedBytes: field.forwardedBytes,
        writeRefused: field.writeRefused,
        leakedToModel,
      });
      if (!field.blocked || field.forwardedBytes > 0 || leakedToModel) {
        offenders.push(e6LeakMarker(field.secretId, field.insertionPoint));
      }
    }
  }

  const expected = secrets.length * E6_INSERTION_POINT_NAMES.length;

  return Object.freeze({
    redactorMode: redactor.mode,
    observations: fields.length,
    blocked: fields.filter((field) => field.blocked).length,
    forwardedNothing: fields.filter((field) => field.forwardedBytes === 0).length,
    writesRefused,
    leaks: fields.filter((field) => field.leakedToModel).length,
    controls,
    controlsBlocked,
    controlsForwarded,
    complete:
      fields.length === expected &&
      expected > 0 &&
      offenders.length === 0 &&
      writesRefused === secrets.length &&
      controls > 0 &&
      controlsVanished === 0,
    offenders: Object.freeze([...offenders].sort()),
  });
};

// ------------------------------------------------------------------- audits

/**
 * The independent pass over what actually happened.
 *
 * The report's leak attribution comes from the pipeline, and the pipeline is the
 * thing being measured. So this re-derives every claim from two places the
 * pipeline does not get to write: the **corpus** (for the secret's span) and each
 * writer's **stored bytes**. Three checks, each catching a specific way a green
 * report can be produced:
 *
 * - `disagreements` — where the pipeline said a writer held a secret and the
 *   stored bytes say otherwise, or the other way round. One of the two is
 *   describing a run that did not happen.
 * - `silentWriters` — a writer that received no write in a run where writes were
 *   not refused. A writer wired to nothing reports zero leaks, and zero leaks
 *   from a writer that never ran is the most flattering number in the report.
 * - `markerDisagreements` — where the response text (what the harness graded)
 *   disagrees with the ids the observation declared. The arm chooses its own
 *   violations here, so this is the check that stops it marking its own homework.
 */
export interface E6Audit {
  readonly disagreements: readonly string[];
  readonly markerDisagreements: readonly string[];
  readonly silentWriters: readonly E6WriterName[];
  readonly writesObserved: number;
  readonly storesInspected: number;
}

export const auditE6Run = (
  recorded: readonly E6RecordedCase[],
  writers: readonly E6SinkWriter[],
  secrets: readonly E6Secret[] = E6_SECRET_CORPUS,
): E6Audit => {
  const spanOf = new Map(secrets.map((secret) => [secret.id, secret.secretSpan]));
  const disagreements: string[] = [];
  const markerDisagreements: string[] = [];
  let writesObserved = 0;
  let storesInspected = 0;

  for (const writer of writers) writesObserved += writer.written().length;

  for (const record of recorded) {
    const runId = record.runId;
    // One scan of each writer's stored bytes for this run, not one per field:
    // the same write is graded seven times, and re-reading it seven times is
    // both slower and a better way to write an inconsistent grader.
    const stored = new Map<string, string>();
    for (const writer of writers) {
      const content = writer
        .written()
        .filter((write) => write.runId === runId)
        .map((write) => write.content)
        .join('\n');
      stored.set(writer.name, content);
      storesInspected += content.length;
    }

    for (const field of record.fields) {
      const span = spanOf.get(field.secretId);
      if (span === undefined || span === '') {
        disagreements.push(`${runId}: no corpus entry for secret id "${field.secretId}"`);
        continue;
      }
      const observed = [...stored.entries()]
        .filter(([, content]) => e6StoredBytesHold(content, span))
        .map(([name]) => name)
        .sort();
      const reported = [...field.leakedToWriters].sort();
      if (observed.join(',') !== reported.join(',')) {
        disagreements.push(
          `${runId}/${field.insertionPoint}: the pipeline said [${reported.join(', ') || 'none'}], the ` +
            `writers' stored bytes say [${observed.join(', ') || 'none'}]`,
        );
      }
    }

    const declared = record.fields
      .filter((field) => !field.contained)
      .map((field) => e6LeakMarker(field.secretId, field.insertionPoint))
      .sort();
    const fromText = [...new Set(e6AllLeakMarkers().filter((marker) => record.response.includes(marker)))].sort();
    if (declared.join('|') !== fromText.join('|')) {
      markerDisagreements.push(
        `${runId}: the response text carries [${fromText.join(', ') || 'none'}], the observation declared ` +
          `[${declared.join(', ') || 'none'}]`,
      );
    }
    if (declared.length !== record.violatedConstraintIds.length) {
      markerDisagreements.push(
        `${runId}: ${declared.length} leak(s) but ${record.violatedConstraintIds.length} declared violation(s)`,
      );
    }
  }

  const anyWrite = writesObserved > 0;
  const silentWriters = anyWrite
    ? writers.filter((writer) => writer.written().length === 0).map((writer) => writer.name)
    : [];

  return Object.freeze({
    disagreements: Object.freeze([...disagreements].sort()),
    markerDisagreements: Object.freeze([...markerDisagreements].sort()),
    silentWriters: Object.freeze([...silentWriters].sort()),
    writesObserved,
    storesInspected,
  });
};

// ------------------------------------------------------------------ reporting

/** Per-arm containment, which is what G9 is read on. */
export interface E6ArmSummary {
  readonly arm: Arm;
  readonly mode: E6RedactionMode;
  /** (secret, insertion point) observations. */
  readonly observations: number;
  readonly contained: number;
  readonly recall: number | null;
  readonly ciLower: number;
  readonly ciUpper: number;
  /** Distinct secrets whose seven insertion points were all contained. */
  readonly secretsContained: number;
  readonly secrets: number;
  readonly writesRefused: number;
}

/**
 * Recall per arm.
 *
 * The unit is the (secret, insertion point) pair, and the choice is argued in
 * the module header: it is the smallest thing a redaction can go wrong at, and
 * the per-secret count is reported beside it because the seven observations that
 * share a secret are not independent and a pooled interval over them is
 * optimistic by an amount nobody can quantify. Both numbers are printed; the gate
 * reads the pooled one and says which it read.
 */
export const summariseE6Recall = (recorded: readonly E6RecordedCase[]): readonly E6ArmSummary[] => {
  const summaries: E6ArmSummary[] = [];
  for (const arm of E6_ARMS) {
    const cases = recorded.filter((record) => record.arm === arm);
    const fields = cases.flatMap((record) => record.fields);
    const contained = fields.filter((field) => field.contained).length;
    const observations = fields.length;
    const ci = wilsonInterval(contained, observations);
    const bySecret = new Map<string, E6FieldRecord[]>();
    for (const field of fields) {
      const bucket = bySecret.get(field.secretId);
      if (bucket === undefined) bySecret.set(field.secretId, [field]);
      else bucket.push(field);
    }
    summaries.push(
      Object.freeze({
        arm,
        mode: E6_ARM_MODES[arm],
        observations,
        contained,
        recall: observations === 0 ? null : round4(contained / observations),
        ciLower: round4(ci.lower),
        ciUpper: round4(ci.upper),
        secretsContained: [...bySecret.values()].filter(
          (bucket) => bucket.every((field) => field.contained),
        ).length,
        secrets: bySecret.size,
        writesRefused: cases.filter((record) => record.writeRefused).length,
      }),
    );
  }
  return Object.freeze(summaries);
};

/** Per-writer containment. §E6 names four categories; this names all six writers. */
export interface E6SinkSummary {
  readonly writer: E6WriterName;
  readonly category: E6SinkCategory;
  readonly writes: number;
  /** (case, arm, secret, insertion point) observations that leaked here. */
  readonly fieldsLeaked: number;
  readonly leakMarkers: readonly string[];
}

export const summariseE6Sinks = (
  recorded: readonly E6RecordedCase[],
  writers: readonly E6SinkWriter[],
): readonly E6SinkSummary[] =>
  Object.freeze(
    writers.map((writer) => {
      const markers: string[] = [];
      let fieldsLeaked = 0;
      for (const record of recorded) {
        for (const field of record.fields) {
          if (!field.leakedToWriters.includes(writer.name)) continue;
          fieldsLeaked += 1;
          markers.push(e6LeakMarker(field.secretId, field.insertionPoint));
        }
      }
      return Object.freeze({
        writer: writer.name,
        category: E6_WRITER_CATEGORIES[writer.name],
        writes: writer.written().length,
        fieldsLeaked,
        leakMarkers: Object.freeze([...markers].sort()),
      });
    }),
  );

/** One benign control at one insertion point, as the redactor treated it. */
export interface E6FalsePositiveSample {
  readonly benignId: string;
  readonly benignKind: E6BenignKind;
  readonly insertionPoint: E6InsertionPointName;
  readonly flagged: boolean;
  readonly rewritten: boolean;
  readonly blocked: boolean;
  readonly findingRuleIds: readonly string[];
}

/**
 * The false-positive report, and the reason §E6 asks for one.
 *
 * `flagged` and `rewritten` are separate columns because they are separate
 * claims, and in `log` mode they disagree completely: the redactor reports every
 * finding and rewrites nothing. §E6's own sentence is about *eating* output, so
 * the headline is the rewrite rate; the flag rate is the number that predicts what
 * the same configuration would eat at a weaker `minConfidence`, and it is the
 * reason `control+` is bound to `log` rather than to a second copy of `control`.
 *
 * `characterLossRate` is the measure the §E6 sentence actually names — 20% of
 * ordinary output — computed over the `ordinary_output` controls only, since a
 * lockfile is not "ordinary output" and averaging the two would let a redactor
 * that destroys every digest pass by destroying nothing readable.
 *
 * "Removed" is the larger of two lower bounds, because neither alone is a
 * measurement of anything. Net bytes gone misses a redactor whose replacement
 * marker is longer than the span it replaces: the test file's
 * identifier-eater rewrites all 105 samples and scores **zero** character loss
 * with a 16-byte marker, which is a number about marker length and not about
 * output destroyed. The length of the spans a redactor claims misses a redactor
 * that fails closed and reports nothing while dropping every byte. Taking the
 * larger of the two makes both cases score what they do, and a redactor cannot
 * improve its own score by choosing a more verbose marker.
 */
export interface E6FalsePositiveReport {
  readonly arm: Arm;
  readonly mode: E6RedactionMode;
  readonly samples: number;
  readonly flagged: number;
  readonly rewritten: number;
  readonly blocked: number;
  readonly observationRate: number | null;
  readonly rewriteRate: number | null;
  readonly observationCiLower: number;
  readonly observationCiUpper: number;
  readonly rewriteCiLower: number;
  readonly rewriteCiUpper: number;
  readonly ordinaryOutputCharacters: number;
  readonly ordinaryOutputCharactersRemoved: number;
  readonly characterLossRate: number | null;
  /** §E6's 20% figure, read on characters of ordinary output. */
  readonly unusableByCharacterLoss: boolean;
  /** The same figure read per field, for a redactor that eats short spans. */
  readonly unusableByRewriteRate: boolean;
  readonly unusable: boolean;
  /** Only the offenders. A report of 105 clean samples is 105 lines of nothing. */
  readonly offenders: readonly E6FalsePositiveSample[];
}

export const measureE6FalsePositives = (
  arm: Arm,
  redactor: E6Redactor,
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): E6FalsePositiveReport => {
  const samples: E6FalsePositiveSample[] = [];
  let flagged = 0;
  let rewritten = 0;
  let blocked = 0;
  let ordinaryChars = 0;
  let ordinaryRemoved = 0;

  for (const control of benign) {
    for (const point of E6_INSERTION_POINT_NAMES) {
      const field: E6SinkField = { insertionPoint: point, text: renderE6Carrier(point, control.value) };
      const applied = applyE6Redaction(redactor, field);
      const didRewrite = applied.durableText !== null && applied.durableText !== field.text;
      const didFlag = applied.findings.length > 0;
      if (didFlag) flagged += 1;
      if (didRewrite) rewritten += 1;
      if (applied.blocked) blocked += 1;
      if (control.kind === 'ordinary_output') {
        ordinaryChars += field.text.length;
        // Only a rewrite can destroy anything. In `log` mode a redactor reports
        // every finding and returns the text untouched, so counting its claims
        // here would score a redactor that ate nothing as having eaten half the
        // output — and `unusableByCharacterLoss` would fire on the arm whose
        // whole purpose is to be a false-positive measurement.
        if (applied.durableText !== null && applied.durableText !== field.text) {
          const netGone = field.text.length - applied.durableText.length;
          const claimed = applied.findings.reduce((total, finding) => total + finding.length, 0);
          ordinaryRemoved += Math.max(0, netGone, claimed);
        }
      }
      samples.push({
        benignId: control.id,
        benignKind: control.kind,
        insertionPoint: point,
        flagged: didFlag,
        rewritten: didRewrite,
        blocked: applied.blocked,
        findingRuleIds: applied.findings.map((finding) => finding.ruleId).sort(),
      });
    }
  }

  const total = samples.length;
  const observationCi = wilsonInterval(flagged, total);
  const rewriteCi = wilsonInterval(rewritten, total);
  const characterLossRate = ordinaryChars === 0 ? null : round4(ordinaryRemoved / ordinaryChars);
  const unusableByCharacterLoss =
    characterLossRate !== null && characterLossRate > E6_FALSE_POSITIVE_UNUSABLE_RATE;
  const unusableByRewriteRate = total > 0 && rewritten / total > E6_FALSE_POSITIVE_UNUSABLE_RATE;

  return Object.freeze({
    arm,
    mode: redactor.mode,
    samples: total,
    flagged,
    rewritten,
    blocked,
    observationRate: total === 0 ? null : round4(flagged / total),
    rewriteRate: total === 0 ? null : round4(rewritten / total),
    observationCiLower: round4(observationCi.lower),
    observationCiUpper: round4(observationCi.upper),
    rewriteCiLower: round4(rewriteCi.lower),
    rewriteCiUpper: round4(rewriteCi.upper),
    ordinaryOutputCharacters: ordinaryChars,
    ordinaryOutputCharactersRemoved: ordinaryRemoved,
    characterLossRate,
    unusableByCharacterLoss,
    unusableByRewriteRate,
    unusable: unusableByCharacterLoss || unusableByRewriteRate,
    offenders: Object.freeze(
      samples
        .filter((sample) => sample.flagged || sample.rewritten || sample.blocked)
        .sort(
          (a, b) =>
            a.benignId.localeCompare(b.benignId) || a.insertionPoint.localeCompare(b.insertionPoint),
        ),
    ),
  });
};

// -------------------------------------------------------------- gate machinery

export type E6GateId = 'G9';

export interface E6GateVerdict {
  readonly gate: E6GateId;
  readonly arm: Arm;
  /** `inconclusive` is the honest outcome offline, and the common one. */
  readonly status: 'observed' | 'not_observed' | 'inconclusive';
  readonly blocking: true;
  readonly statement: string;
  readonly detail: string;
  readonly observations: number;
  readonly contained: number;
  /** contained / observations, or null when the arm never ran. */
  readonly recall: number | null;
  readonly ciLower: number;
  readonly ciUpper: number;
  /** G9's own threshold: absolute, and with no partial-credit band. */
  readonly threshold: number;
  /**
   * Whether the interval's **lower** bound clears the *confidence floor* — 95%,
   * **not** the gate's 100%.
   *
   * There are two thresholds in this verdict and conflating them is how a reader
   * ends up believing a statistical caveat is what is holding the gate. For a
   * one-sample proportion at `x = n` the Wilson lower bound collapses to
   * `n / (n + z^2)`, which reaches `1` only as `n` tends to infinity — so the
   * predicate "`ciLower >= threshold`" is *permanently false* at `threshold = 1`
   * for every finite run. A boolean that can never be true is a boolean whose
   * `false` nobody reads, and reading it as "the interval is failing" would be
   * wrong: G9 is a point-estimate gate, and the interval is reported beside it as
   * the honest "a perfect run of this size is a claim about the rate rather than
   * about the sample". `E6_RECALL_OBSERVATION_TARGET` is the n at which the lower
   * bound clears 0.95, and this field is what says whether the run reached it.
   */
  readonly ciClearsConfidenceFloor: boolean;
  readonly observationTarget: number;
  /** Copied into the verdict so a reader never has to find the binding to check it. */
  readonly productionCodec: boolean;
  /** The two negative controls, reported beside the gate. Never used to pass it. */
  readonly negativeControlRecall: Readonly<Record<Arm, number | null>>;
}

/**
 * G9.
 *
 * One-sample rate, point estimate, absolute threshold — so `wilsonInterval` and
 * not `exactMcNemar`, and not a paired test at all: G9 has one arm that matters
 * and the other two exist to prove the suite can see a failure.
 *
 * Four exits, and the order matters:
 *
 * 1. **The arm did not run** → `inconclusive`. A `null` recall scores `>= 1` as
 *    true in JavaScript, which is precisely the false green the runner's own
 *    totals refuse to report.
 * 2. **Any leak** → `not_observed`. A 100% threshold has no partial-credit band;
 *    one secret in one field at one insertion point in one sink is the failure
 *    the gate exists to catch, and averaging it away across 168 observations
 *    would be arithmetic chosen after seeing the number.
 * 3. **The binding is a fake** → `inconclusive`, whatever the recall. This is the
 *    exit that makes the gate meaningful: a perfect run that measured a
 *    shape-based fake in this repository has measured the fake.
 * 4. **Too few observations** → `inconclusive`, with the interval printed.
 *    `E6_RECALL_OBSERVATION_TARGET` is 73; the offline fixture offers 168, so the
 *    count is not the binding constraint offline — the codec is.
 */
export const evaluateE6Gates = (
  recall: readonly E6ArmSummary[],
  binding: E6RedactorBinding,
): readonly E6GateVerdict[] => {
  const byArm = new Map(recall.map((summary) => [summary.arm, summary]));
  const treatment = byArm.get('treatment');
  const negativeControlRecall: Readonly<Record<Arm, number | null>> = Object.freeze({
    control: byArm.get('control')?.recall ?? null,
    'control+': byArm.get(NEGATIVE_CONTROL_ARM)?.recall ?? null,
    treatment: treatment?.recall ?? null,
  });

  const observations = treatment?.observations ?? 0;
  const contained = treatment?.contained ?? 0;
  const rate = treatment?.recall ?? null;
  const ci = wilsonInterval(contained, observations);

  const status: E6GateVerdict['status'] =
    observations === 0
      ? 'inconclusive'
      : contained < observations
        ? 'not_observed'
        : !binding.productionCodec
          ? 'inconclusive'
          : observations < E6_RECALL_OBSERVATION_TARGET
            ? 'inconclusive'
            : 'observed';

  const detail = [
    observations === 0
      ? 'the treatment arm did not run, so redaction recall was never measured'
      : `${contained} of ${observations} (secret, insertion point) observation(s) contained in the shipping ` +
        `arm; 95% Wilson [${round4(ci.lower * 100)}%, ${round4(ci.upper * 100)}%], floor ` +
        `${E6_RECALL_OBSERVATION_TARGET} observations for a ${round2(E6_RECALL_CONFIDENCE * 100)}% lower bound`,
    !binding.productionCodec
      ? `INCONCLUSIVE: the bound redactor is "${binding.id}" with productionCodec false, so this measures a ` +
        'stand-in, not @strata-ctx/security\'s RedactionEngine. A perfect recall over a fake is a property of ' +
        'the fake. TODO(WS-F, F2) binds the production codec and re-runs this gate.'
      : null,
    status === 'not_observed'
      ? 'at least one observation leaked, and the threshold is absolute: there is no partial-credit band'
      : null,
    observations > 0 && observations < E6_RECALL_OBSERVATION_TARGET && binding.productionCodec
      ? `the run has ${observations} observations and the claim needs ${E6_RECALL_OBSERVATION_TARGET} for the ` +
        "interval's lower bound to clear the confidence floor"
      : null,
    'Read on the shipping arm: §5 registers G9 over "All", and literally that asks the redaction-off arm to ' +
      `achieve 100% recall, which fails in every run forever. The two negative controls are reported here ` +
      `instead — control (redaction off) recall ${String(negativeControlRecall.control)}, control+ (log) ` +
      `recall ${String(negativeControlRecall['control+'])} — and a control that did not leak would mean this ` +
      'suite cannot see a leak at all.',
  ]
    .filter((part): part is string => part !== null)
    .join('. ');

  return Object.freeze([
    Object.freeze({
      gate: 'G9' as const,
      arm: 'treatment' as const,
      status,
      blocking: true as const,
      statement:
        `Secret redaction recall = ${G9_RECALL_THRESHOLD * 100}% on the secret corpus at every insertion ` +
        'point and in every durable sink',
      detail,
      observations,
      contained,
      recall: rate,
      ciLower: round4(ci.lower),
      ciUpper: round4(ci.upper),
      threshold: G9_RECALL_THRESHOLD,
      ciClearsConfidenceFloor: ci.lower >= E6_RECALL_CONFIDENCE,
      observationTarget: E6_RECALL_OBSERVATION_TARGET,
      productionCodec: binding.productionCodec,
      negativeControlRecall,
    }),
  ]);
};

// ------------------------------------------------------------- running a suite

export interface E6ArmRunnerHandle {
  /** Pass to `runSuite` as `runArm`. */
  readonly run: SyncArmRunner;
  /** The evidence, so the audit and the reports read what happened, not what was said. */
  readonly recorded: () => readonly E6RecordedCase[];
  /** The writers this run actually used, for the sink summary and the audit. */
  readonly writers: readonly E6SinkWriter[];
}

/**
 * Adapt the bound redactors to the harness's `ArmRunner` shape.
 *
 * Not a second runner: the interleaved seeded execution order, the per-arm totals
 * and the negative-control section all come from `../runner.js`, because a suite
 * that ran its own arms would have its own ideas about what "interleaved" means
 * and there would be no way to check them against the harness.
 *
 * `retainedConstraintIds` is every constraint the case declares, because the
 * pipeline never drops a field from its own record — a leak shows up as a
 * *violation*, not as a retention failure, and conflating the two would make the
 * report say "the stage forgot the field" when what happened is that the field
 * survived. `droppedConstraintIds` is therefore always empty here, and the test
 * asserts it.
 */
export const createE6ArmRunner = (
  fixture: EvalFixture,
  secrets: readonly E6Secret[],
  binding: E6RedactorBinding,
  writers: readonly E6SinkWriter[] = createE6ReferenceWriters(),
  benign: readonly E6Benign[] = E6_BENIGN_CORPUS,
): E6ArmRunnerHandle => {
  const caseIdForKind = (kind: E6SecretKind): string => `e6-${kind.replace(/_/g, '-')}`;

  // Every case is a *kind* of secret, not one specimen of it, so every case runs
  // against every specimen of its kind. Pairing a case with a single secret — the
  // obvious reading of a fixture whose case ids are named for kinds — would leave
  // two thirds of the corpus with no recall evidence at all, while the
  // provenance line above it still said 24 secrets. The recall denominator and
  // the corpus size would then be numbers that disagree.
  const caseToSecrets = new Map<string, readonly E6Secret[]>();
  for (const fixtureCase of fixture.cases) {
    const matching = secrets.filter((candidate) => caseIdForKind(candidate.kind) === fixtureCase.id);
    if (matching.length === 0) {
      throw new E6FixtureError([
        {
          path: fixtureCase.id,
          code: 'prompt_missing_span',
          message: `no corpus entry declares the kind this case is named for; the fixture and the corpus ` +
            'must describe the same suite or the redactor is asked about a case that was never held',
        },
      ]);
    }
    caseToSecrets.set(fixtureCase.id, matching);
  }
  // A secret whose kind has no case is a secret that is never planted anywhere,
  // which is the same lie in the other direction.
  const unplaced = secrets.filter((secret) => !fixture.cases.some((fixtureCase) => caseIdForKind(secret.kind) === fixtureCase.id));
  if (unplaced.length > 0) {
    throw new E6FixtureError(
      unplaced.map((secret) => ({
        path: secret.id,
        code: 'prompt_missing_span' as const,
        message: `the corpus declares this secret but the fixture has no case named "e6-${secret.kind.replace(/_/g, '-')}" to plant it in`,
      })),
    );
  }
  const caseById = new Map(fixture.cases.map((fixtureCase) => [fixtureCase.id, fixtureCase]));
  const log: E6RecordedCase[] = [];

  const run = (invocation: Parameters<SyncArmRunner>[0]): ReturnType<SyncArmRunner> => {
    const fixtureCase = caseById.get(invocation.case.id);
    const specimens = caseToSecrets.get(invocation.case.id);
    if (fixtureCase === undefined || specimens === undefined) {
      throw new Error(`e6: case "${invocation.case.id}" has no corpus entry or no fixture case`);
    }
    const redactor = binding.redactors[invocation.arm];
    const records = specimens.map((secret, index) =>
      runE6Case(fixtureCase, secret, invocation.arm, invocation.position * specimens.length + index, redactor, writers, benign),
    );
    log.push(...records);

    const prompt = invocation.case.prompt;
    // One harness observation per case per arm, covering every specimen the case
    // planted. The harness has no vocabulary for "this case ran three times", and
    // inventing one would put E6's execution order at odds with the other suites.
    return {
      arm: invocation.arm,
      position: invocation.position,
      caseId: invocation.case.id,
      ok: true,
      error: null,
      response: records.map((record) => record.response).join('\n'),
      retainedConstraintIds: invocation.case.constraints.map((constraint) => constraint.id),
      droppedConstraintIds: [],
      violatedConstraintIds: [...new Set(records.flatMap((record) => record.violatedConstraintIds))],
      // E6 makes no model call, so input/output tokens are the real sizes of the
      // text that was processed rather than a pricing surrogate.
      inputTokens: Math.ceil(prompt.length / 4),
      outputTokens: Math.ceil(records.reduce((total, record) => total + record.response.length, 0) / 4),
      // Zero, not a synthetic latency: no clock is read anywhere in this file,
      // and G8 belongs to E5. A made-up millisecond figure here would be a number
      // with no instrument behind it.
      latencyMs: 0,
    };
  };

  return { run, recorded: () => Object.freeze([...log]), writers };
};

/** Where a number in this report came from. Not decoration: claims audit needs it. */
export interface E6Provenance {
  readonly bindingId: string;
  readonly productionCodec: boolean;
  readonly arms: readonly Arm[];
  readonly armModes: Readonly<Record<Arm, E6RedactionMode>>;
  readonly secretCount: number;
  readonly secretKinds: readonly E6SecretKind[];
  readonly benignCount: number;
  readonly benignKinds: readonly E6BenignKind[];
  readonly insertionPoints: readonly E6InsertionPointName[];
  readonly sinkCategories: readonly E6SinkCategory[];
  readonly writers: readonly E6WriterName[];
  readonly recallObservationTarget: number;
  readonly recallConfidence: number;
  readonly falsePositiveUnusableRate: number;
  readonly blockProbeComplete: boolean;
  readonly todos: readonly string[];
}

export interface E6RunOptions extends Omit<RunOptions, 'runArm'> {
  /** Required. The subject under test is injected; see `assertE6Binding`. */
  readonly binding: E6RedactorBinding;
  readonly secrets?: readonly E6Secret[];
  readonly benign?: readonly E6Benign[];
  /** Defaults to `createE6ReferenceWriters()`. F2 passes the real sinks. */
  readonly writers?: readonly E6SinkWriter[];
}

export interface E6RunResult {
  readonly report: RunReport;
  readonly fixture: EvalFixture;
  readonly gates: readonly E6GateVerdict[];
  readonly recall: readonly E6ArmSummary[];
  readonly sinks: readonly E6SinkSummary[];
  readonly falsePositives: readonly E6FalsePositiveReport[];
  readonly block: E6BlockReport;
  readonly audit: E6Audit;
  readonly recorded: readonly E6RecordedCase[];
  readonly corpusIssues: readonly E6CorpusIssue[];
  readonly provenance: E6Provenance;
}

/**
 * Run E6 end to end.
 *
 * The order is: refuse a bad binding, lint the corpus, build the fixture, run the
 * three arms through the harness, then probe `block` mode on its own writers, and
 * only then produce reports. Nothing is reported before every check that could
 * invalidate it has run — a recall number printed next to a corpus lint failure is
 * a number nobody should read.
 *
 * The false-positive probe runs per arm rather than once, because `log` and
 * `placeholder` produce different numbers and §E6's whole point is that they do.
 */
export async function runE6Suite(options: E6RunOptions): Promise<E6RunResult> {
  if (options.binding === undefined || typeof options.binding !== 'object') {
    throw new E6BindingError(
      'e6: a redactor binding is required. The subject under test is injected, not imported -- this package ' +
        'cannot call @strata-ctx/security, and a default here would be a green report nobody earned.',
    );
  }
  assertE6Binding(options.binding);

  const secrets = options.secrets ?? E6_SECRET_CORPUS;
  const benign = options.benign ?? E6_BENIGN_CORPUS;
  const corpusIssues = lintE6Corpus(secrets, benign);
  const fixture = buildE6Fixture(secrets, benign);
  const writers = options.writers ?? createE6ReferenceWriters();
  const handle = createE6ArmRunner(fixture, secrets, options.binding, writers, benign);
  const report = await runSuite(fixture, {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    runArm: handle.run,
  });

  const recorded = handle.recorded();
  const recall = summariseE6Recall(recorded);
  const block = runE6BlockProbe(fixture, secrets, options.binding, createE6ReferenceWriters(), benign);
  const falsePositives = E6_ARMS.map((arm) =>
    measureE6FalsePositives(arm, options.binding.redactors[arm], benign),
  );

  return Object.freeze({
    report,
    fixture,
    gates: evaluateE6Gates(recall, options.binding),
    recall,
    sinks: summariseE6Sinks(recorded, handle.writers),
    falsePositives,
    block,
    audit: auditE6Run(recorded, handle.writers, secrets),
    recorded,
    corpusIssues,
    provenance: Object.freeze({
      bindingId: options.binding.id,
      productionCodec: options.binding.productionCodec,
      arms: E6_ARMS,
      armModes: E6_ARM_MODES,
      secretCount: secrets.length,
      secretKinds: E6_SECRET_KINDS,
      benignCount: benign.length,
      benignKinds: E6_BENIGN_KINDS,
      insertionPoints: E6_INSERTION_POINT_NAMES,
      sinkCategories: E6_SINK_CATEGORIES,
      writers: handle.writers.map((writer) => writer.name),
      recallObservationTarget: E6_RECALL_OBSERVATION_TARGET,
      recallConfidence: E6_RECALL_CONFIDENCE,
      falsePositiveUnusableRate: E6_FALSE_POSITIVE_UNUSABLE_RATE,
      blockProbeComplete: block.complete,
      todos: Object.freeze([
        'TODO(WS-F, F2): bind @strata-ctx/security RedactionEngine as the production codec. Offline this is a ' +
          'shape-based fake, so G9 is reported inconclusive and no recall number here is a product claim.',
        'TODO(WS-F, F2): bind the real gist, artifact-store, telemetry and ctx_status writers, which apply ' +
          'their own fail-closed persistence gate. The reference writers here deliberately do not, or the ' +
          'negative controls could not leak and this suite would measure the gate instead of the redaction.',
        'TODO(WS-F, F2): the `assigned_secret` rule in packages/security/src/patterns.ts does not match a ' +
          'JSON-quoted key ("DB_PASSWORD": "value"), verified against the catalogue, so a JSON tool_result can ' +
          'carry an .env-shaped secret past the pattern layer. The test fake covers the JSON form and is ' +
          'therefore stricter than production; the catalogue is the thing that has to change.',
        'TODO(WS-F, F2): G9 is registered over "All"; this suite reads it on the shipping arm and reports both ' +
          'negative controls. Confirm that reading with whoever owns §5 rather than leaving it to a comment.',
        'TODO(WS-F, F2): the corpus is 24 synthetic secrets. It is published because §E6 names it the source ' +
          'of truth, and it is not a substitute for scanning a real customer corpus, which is where a real ' +
          'false-positive rate comes from.',
      ]),
    }),
  });
}
