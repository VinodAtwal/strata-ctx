import type { StrataTelemetryEvent, TelemetryRecord } from './events.js';

/**
 * G-7: redaction in *every* sink.
 *
 * ## Why this package redacts at all
 *
 * E6: compression is not a DLP control, it changes *where* sensitive data
 * lives. A secret in a tool result is transient in the raw context and becomes
 * permanent in a gist -- and, before the artifact store, in the telemetry log.
 * Telemetry is the one sink nobody thinks of as a copy of the user's data,
 * because the events are supposed to be numbers. They are not: `error.message`,
 * `stage` details and any future free-text field carry command lines, file
 * paths and stack traces, and a stack frame containing a connection string is
 * an ordinary Tuesday.
 *
 * So: redaction happens on the way *into* every sink, before serialisation, and
 * the serialised line is scanned again before the write syscall. Two passes
 * because the second one is the one the test can make a claim about -- a
 * placeholder written into a field the first pass did not know about is still a
 * secret on disk if nothing looks at the bytes.
 *
 * ## Scope, stated honestly
 *
 * Two layers live here:
 *
 * 1. **Field-based** (key denylist) -- the one that matters for telemetry, and
 *    the one that is not a heuristic.
 * 2. **Format-based** (unambiguous credential shapes) -- value-side, so a secret
 *    embedded in a log line or an error message is caught even though the field
 *    name is innocent.
 *
 * Entropy scoring is *not* here. It belongs to I-1 (secret redaction engine:
 * patterns + entropy) and it is deliberately not duplicated: the obvious
 * entropy rule eats the 64-char lowercase hex digests this codebase uses for
 * `policyHash` and every `meta.sha256`, which are the evidence telemetry exists
 * to record. A redactor that eats the audit trail is worse than no redactor. If
 * I-1 ships an entropy pass, it plugs in beside these two layers, and its
 * false-positive rate gets measured by E6 -- not silently assumed here.
 *
 * ## Fail direction
 *
 * If redaction itself throws, the sink refuses to write the line. That is
 * fail-*closed*, which is the opposite of the product's default (fail open,
 * pass the user's context through untouched, architecture §1) and is correct
 * here for a specific reason: the product's fail-open rule exists so that a bug
 * never costs a user their context. Losing an instrumentation line costs nobody
 * anything, while writing a secret to a file the user believes is local costs
 * them the product's central claim (N4, data locality).
 */

export const REDACTED = '[redacted]';

/**
 * Keys whose *value* is a credential whatever the value looks like. Matched on
 * the key with case and punctuation stripped, so `api_key`, `apiKey` and
 * `APIKEY` are one rule.
 *
 * The suffix forms are deliberate and carry a naming rule with them: a
 * measurement field must not *end* in a secret-ish word. `inputTokens` is safe
 * because of the plural; a field called `outputToken` would be redacted. That is
 * why every token field in this package is plural.
 */
const DENYLIST_EXACT: readonly string[] = Object.freeze([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
  'passwd',
  'pwd',
  'sessionid',
  'sessiontoken',
  'token',
]);

const DENYLIST_SUFFIX: readonly string[] = Object.freeze([
  'apikey',
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'privatekey',
  'clientsecret',
]);

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Words that make a *compound* key sensitive whatever surrounds them.
 *
 * `STRIPE_SECRET_KEY` is the canonical miss for a suffix rule: nothing in it
 * ends in a denylisted word, and yet its value is unambiguously a credential.
 * Env-var and config naming is segment-structured, so the check is
 * segment-structured too.
 *
 * The list deliberately omits `token` and `key` on their own. Those are the two
 * words that collide with this package's own vocabulary -- `inputTokens`,
 * `beforeTokens`, `tokensByCategory` -- and a redactor that eats the
 * measurement fields is worse than no redactor. `apiKey` and `accessKey` are
 * in the list as *joined* segments, where they cannot collide.
 */
const SECRET_SEGMENTS: readonly string[] = Object.freeze([
  'secret',
  'secrets',
  'password',
  'passwords',
  'passwd',
  'credential',
  'credentials',
  'privatekey',
  'apikey',
  'apisecret',
  'accesskey',
  'accesskeyid',
  'sessionid',
  'authorization',
  'cookie',
]);

/**
 * Splits a key into lowercase segments on separators *and* camelCase
 * boundaries, so `STRIPE_SECRET_KEY`, `stripeSecretKey` and
 * `stripe-secret-key` are one shape.
 */
const keySegments = (key: string): string[] =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s !== '')
    .map((s) => s.toLowerCase());

export function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  if (DENYLIST_EXACT.includes(k)) return true;
  if (DENYLIST_SUFFIX.some((suffix) => k.endsWith(suffix))) return true;
  return keySegments(key).some((segment) => SECRET_SEGMENTS.includes(segment));
}

export interface RedactionRule {
  readonly id: string;
  readonly pattern: RegExp;
  /**
   * Capture groups that are *not* secret, re-emitted verbatim ahead of the
   * placeholder.
   *
   * This exists because the obvious implementation -- `String.replace` with a
   * string replacement -- throws the captures away, and a URL rule that
   * reduces `postgres://user:pw@host` to `[redacted]` destroys the one piece
   * of context that told an operator *which* service failed. Keeping the
   * non-secret prefix is not a partial mask of the secret: the prefix is a
   * label, and the secret itself is still replaced by a constant.
   */
  readonly keepGroups: readonly number[];
  /**
   * Capture groups re-emitted *after* the placeholder.
   *
   * Separate from `keepGroups` because the two cannot share one list: a closing
   * quote is context, and it has to land after the redaction, not before it.
   * Emitting both through one ordered list puts the closing quote in the middle
   * and yields `password: ""[redacted]`.
   */
  readonly suffixGroups?: readonly number[];
}

/**
 * Value-side rules. Each is a *format* claim, not a heuristic: every alternative
 * is either a documented provider prefix or a shape no ordinary agent output
 * produces. `source` on the row is the first-party format spec, not folklore.
 */
export const REDACTION_RULES: readonly RedactionRule[] = Object.freeze([
  {
    id: 'pem_private_key',
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    keepGroups: [],
  },
  { id: 'anthropic_api_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, keepGroups: [] },
  { id: 'openai_style_key', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, keepGroups: [] },
  { id: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, keepGroups: [] },
  { id: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, keepGroups: [] },
  { id: 'github_token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, keepGroups: [] },
  { id: 'slack_token', pattern: /\bxox[abopsr]-[A-Za-z0-9-]{10,}/g, keepGroups: [] },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    keepGroups: [],
    suffixGroups: [],
  },
  // Group 1 is the scheme word and its trailing space. Keeping it says *which*
  // credential kind was presented, which is usually the difference between a
  // 401 and a proxy bug.
  {
    id: 'bearer_header',
    pattern: /\b((?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    keepGroups: [1],
  },
  // Credentials inside a URL: keep the scheme so the log still says which
  // service failed, drop the userinfo that carries the password.
  { id: 'url_userinfo', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, keepGroups: [1] },
  {
    id: 'assigned_secret',
    // `[` is excluded from the value class for one reason: the placeholder is
    // `[redacted]`, and a value class that accepts `[` makes the rule match its
    // own output. That turns a redaction into `password: [redacted]]` on the
    // second pass, which is how a redaction rule quietly becomes a mangler.
    //
    // The value also has to be able to swallow `\"` as a *unit* (`\\["'\\]`),
    // not just as two characters. Redaction runs on serialised records, so the
    // quotes around a secret arrive escaped: `password: \"hunter2hunter2\"`.
    // Read character by character, that value class stops at the first `"` --
    // one character in, short of the `{4,}` floor -- and the rule declines to
    // match. The secret is then written to disk, silently, because the rule that
    // was supposed to catch it reported "nothing to redact". A character class
    // that does not know about the escaping convention of the format it runs on
    // is not a redaction rule, it is a decoration.
    pattern:
      /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|auth[_-]?token)\b(\s*[:=]\s*)(["']?)((?:\\["'\\]|[^"'[\]\s,;&)}]){4,})(\3)/gi,
    // Group 5 is the closing quote, captured as `(\3)` rather than left as a bare
    // backreference. A bare `\3` consumes the quote and then throws it away,
    // leaving `password: "[redacted]` -- an unbalanced quote on a line that is a
    // fragment of a JSON document. It has to be `suffixGroups` and not a fifth
    // entry in `keepGroups`: one ordered list puts the closing quote in the middle
    // of the replacement and yields `password: ""[redacted]`.
    //
    // The key word, the separator and the opening quote lead; the closing quote
    // trails. The redacted line stays readable as `password: "[redacted]"`.
    keepGroups: [1, 2, 3],
    suffixGroups: [5],
  },
  {
    id: 'env_assignment',
    // Not anchored to the start of a line. An `.env` value reaches telemetry
    // embedded in a command's output or a config dump, not as a tidy first
    // line, and an anchored rule only catches the tidy case. The name must
    // have an underscore before the secret word, which is what keeps `MONKEY=1`
    // and `WHISKEY=aged` out of the results.
    //
    // The boundary is a negative *lookbehind*, not a consumed `(?:^|[^...])`
    // group. The consumed form takes the preceding character into the match and
    // then drops it, because only group 1 is re-emitted -- so
    // `failed with STRIPE_SECRET_KEY=...` redacted to `failed withSTRIPE_...`.
    // No secret leaks and every test still passes; the log just quietly loses a
    // space, one character at a time, and the text stops matching what happened.
    //
    // `(?![\redacted])` keeps the rule from matching its own output. Without it
    // `STRIPE_SECRET_KEY=[redacted]` is a permanent match: the replacement is
    // textually identical, so the text is stable, but the pass still reports a
    // hit, and the write guard asks "does any rule match this line?" rather than
    // "would redacting this line change it?". So an already-safe line keeps
    // reporting itself as unsafe, and the sink refuses to write its own
    // redaction. That is the worst shape this bug can take: the safety net
    // denying service to the thing it exists to protect.
    pattern:
      /(?<![A-Za-z0-9_])((?:[A-Z][A-Z0-9]*_)+(?:KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|CREDENTIALS?)\s*=\s*)(?!\[redacted\])(?:"[^"]*"|'[^']*'|\S+)/gm,
    keepGroups: [1],
  },
]);

export interface RedactionHit {
  readonly ruleId: string;
}

export interface RedactedText {
  readonly text: string;
  readonly hits: readonly RedactionHit[];
}

/**
 * Two passes, both bounded by the rule count, so a substitution that *exposes*
 * a new match (a masked URL userinfo revealing an assignment, say) is still
 * caught. Two is not arbitrary: the second pass only runs when the first one
 * changed something, so the common case -- a line with no secret -- costs one
 * pass.
 */
const MAX_PASSES = 2;

/**
 * Replaces every pattern match with a constant placeholder.
 *
 * The replacement is a constant, never a partial mask. A mask like
 * `sk-a****z` leaks length and position, and length is a real leak for a fixed
 * length credential class (an AWS key id is 20 characters; knowing that is
 * enough to confirm a guess).
 */
export function redactTextWithHits(text: string): RedactedText {
  const hits: RedactionHit[] = [];
  let out = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let changed = false;
    for (const rule of REDACTION_RULES) {
      // A fresh regex per rule per call: `lastIndex` on a shared /g regex is
      // stateful across calls, and purity is what the determinism requirement
      // (N6) depends on.
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      if (!re.test(out)) continue;
      hits.push({ ruleId: rule.id });
      out = replaceAllKeepingGroups(
        out,
        new RegExp(rule.pattern.source, rule.pattern.flags),
        rule.keepGroups,
        rule.suffixGroups ?? [],
      );
      changed = true;
    }
    if (!changed) break;
  }
  return { text: out, hits };
}

/**
 * Replaces every match with the rule's non-secret groups followed by the
 * constant placeholder.
 *
 * Hand-rolled rather than `String.replace` with a `$1`-style string, for two
 * reasons. First, `$1` references only emit the groups the author remembered
 * to name, and the failure mode is silent: the secret is still removed so
 * nothing looks wrong, and the log has quietly lost the only line that said
 * which host or which variable was involved. Second, an explicit scan is
 * unambiguous about which array element is a capture and which is the input,
 * so adding a named group to a rule cannot shift the indices underneath it.
 */
function replaceAllKeepingGroups(
  input: string,
  pattern: RegExp,
  keepGroups: readonly number[],
  suffixGroups: readonly number[],
): string {
  const re = new RegExp(pattern.source, pattern.flags);
  const kept = (match: RegExpExecArray, groups: readonly number[]): string => {
    let text = '';
    for (const index of groups) {
      const group = match[index];
      if (typeof group === 'string') text += group;
    }
    return text;
  };
  let out = '';
  let cursor = 0;
  let match = re.exec(input);
  while (match !== null) {
    const [whole] = match;
    out += input.slice(cursor, match.index);
    out += `${kept(match, keepGroups)}${REDACTED}${kept(match, suffixGroups)}`;
    // A zero-length match would otherwise spin forever. None of these rules can
    // produce one -- every one requires at least one literal character -- but
    // the guard is free and the failure mode is a hung request path.
    cursor = match.index + (whole === undefined ? 0 : whole.length);
    if (whole === undefined || whole.length === 0) re.lastIndex += 1;
    match = re.exec(input);
  }
  return out + input.slice(cursor);
}

export function redactText(text: string): string {
  return redactTextWithHits(text).text;
}

/** True when the text still contains something any rule would match. */
export function hasRedactionCandidate(text: string): boolean {
  return REDACTION_RULES.some((rule) => {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    // lastIndex is irrelevant: `test` on a fresh regex starts at 0.
    return re.test(text);
  });
}

export interface RedactionOutcome {
  readonly value: unknown;
  readonly hits: readonly RedactionHit[];
}

/**
 * Deep redaction of a JSON-shaped value.
 *
 * Depth-bounded because this runs on the request path and a cyclic or
 * pathologically deep object is a denial of service on a control that is
 * supposed to be free. Past the bound the value is replaced with a marker rather
 * than walked: an unexamined subtree is exactly the thing that must not reach
 * disk.
 */
const MAX_DEPTH = 12;

export function redactValue(value: unknown, depth = 0): RedactionOutcome {
  const hits: RedactionHit[] = [];
  const value2 = walk(value, depth, hits);
  return { value: value2, hits };
}

function walk(value: unknown, depth: number, hits: RedactionHit[]): unknown {
  if (depth > MAX_DEPTH) return '[unredacted-depth-limit]';
  if (typeof value === 'string') {
    const { text, hits: found } = redactTextWithHits(value);
    if (found.length === 0) return value;
    hits.push(...found);
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1, hits));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        hits.push({ ruleId: `key:${key}` });
        out[key] = REDACTED;
        continue;
      }
      out[key] = walk(v, depth + 1, hits);
    }
    return out;
  }
  return value;
}

/**
 * Redacts an event, returning a new one. The event is never mutated: the sink
 * hands the same object to other consumers (a live dashboard, the violation log)
 * and those consumers must see what the pipeline actually produced.
 */
export function redactEvent(event: StrataTelemetryEvent): RedactionOutcome {
  return redactValue(event);
}

export function redactRecord(record: TelemetryRecord): RedactionOutcome {
  return redactValue(record);
}

export class RedactionFailure extends Error {
  constructor(cause: unknown) {
    super(`telemetry redaction failed; refusing to write: ${String(cause)}`);
    this.name = 'RedactionFailure';
  }
}

/**
 * The check the sink runs on the serialised line.
 *
 * A second pass over the *bytes* rather than the object, so the guarantee the
 * test makes is about what is on disk and not about what an object graph
 * claims. Its scope is deliberately narrow and it is worth being exact about
 * what it is, because an overstated backstop is worse than none:
 *
 * - It catches **values** in places pass 1 did not look. A secret smuggled into
 *   a future event member whose value is a bare string, a number rendered as
 *   base64, a stack frame -- none of those have a "sensitive key", and all of
 *   them are on the line.
 * - It does **not** re-implement key-based redaction. JSON quotes its keys, so
 *   `"password":"x"` does not match the value rules, and a key-aware regex
 *   would have to substring-match `token` -- which would eat `inputTokens`,
 *   the single most important field this package records. Key redaction is
 *   pass 1's job, and the control for "a member nobody anticipated" is the
 *   schema check in events.ts, not a regex.
 *
 * Failing closed here means a redactor bug costs an instrumentation line and
 * nothing else, which is the trade the module doc argues for.
 */
export function assertNoSecretsInLine(line: string): void {
  if (!hasRedactionCandidate(line)) return;
  throw new RedactionFailure('a redacted-write guard matched the serialised line');
}
