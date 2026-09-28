import type { ContentBlock, LossyContext, Severity } from '@strata-ctx/core-types';

/**
 * B-4. Severity classification for command output.
 *
 * Why this exists at all: F7 (severity-preserving log compression) is a P0
 * requirement, and it is unimplementable unless something decides which lines
 * are ERROR/FATAL *before* the truncate stage throws bytes away. Classification
 * is therefore a precondition of truncation, not a parallel task -- see
 * ./truncate.ts, which composes this around the cap.
 *
 * The classifier is deliberately dumb and deterministic (N6: same input, byte-
 * identical output). It reads text because that is all the canonical model
 * carries: there is no `exitCode` field on `BlockMeta`, and adding one would be
 * a contract change (noted in the B-4 handoff). A structured exit code supplied
 * by the caller is strictly better than scraping one out of the output, which is
 * why `classifyExitCode` is exported separately.
 *
 * Tier 0 writes its own bookkeeping into block text -- `[strata:truncated]`,
 * `[strata:retained] 3 error/fatal lines`. A marker that says the word "fatal"
 * is, to a regex, a crash report, and a block that read as `error` on the way in
 * would be skipped by the cap, the pointer-izer and the deduper on the way out.
 * Self-poisoning like that compounds every turn, so markers are excluded from
 * classification by the `[strata:` namespace prefix. `severity.test.ts` pins the
 * invariant: no marker this package emits may classify above `info`.
 */

/**
 * Namespace prefix for markers Tier 0 writes into block text. Every marker
 * constant in ./truncate.ts and ./pointer.ts starts with it; that is the whole
 * contract, and the test suite is what keeps them honest.
 */
export const STRATA_MARKER_PREFIX = '[strata:';

const MARKER_LINE = /^\s*\[strata:[a-z-]+]/;

const RANK: Readonly<Record<Severity, number>> = Object.freeze({
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
});

export const SEVERITY_ORDER: readonly Severity[] = Object.freeze([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
]);

export const maxSeverity = (a: Severity, b: Severity): Severity =>
  RANK[a] >= RANK[b] ? a : b;

export const severityAtLeast = (a: Severity, floor: Severity): boolean => RANK[a] >= RANK[floor];

/**
 * A passing run is full of the word "error". `0 errors`, `failures: 0` and
 * `no warnings` are the largest source of false ERROR classification in build
 * logs. The guard is deliberately narrow: it cancels a *count* and nothing
 * else, so it can never mask an exit code or a crash signature.
 */
const NEGATED_COUNT =
  /\b(?:errors?|warnings?|failures?|failing|ignored|pending|skipp?ed|passed)\b[^\n]{0,4}[:=]\s*(?:0|none|nil|false)\b|\b(?:no|zero|0)\b[^\n]{0,10}\b(?:errors?|warnings?|failures?|failing|ignored|pending|skipp?ed)\b/i;

/**
 * Crash evidence only. `fatal` is never inferred from an exit code: mapping
 * 128+n or 126/127 to "fatal" is signal arithmetic nobody has measured, and the
 * project rule is cite-or-flag rather than invent. Non-zero exit codes go to
 * `error`.
 *
 * `^Killed$` and `signal: 9` are the OOM killer's output on Linux and macOS. That
 * is folklore, not a citation -- like `segmentation fault` -- so it is called out
 * as such rather than dressed up as a measured rule. The whole-line anchor is
 * what keeps it honest: "killed" inside a sentence is prose, a line that is only
 * "Killed" is a kernel message.
 */
const FATAL: readonly RegExp[] = [
  /\bfatal\b/i,
  /\bpanic[:!]/i,
  /traceback \(most recent call last\)/i,
  /segmentation fault/i,
  /\bsig(?:segv|abrt|bus|ill|kill|fpe)\b/i,
  /\bsignal:?\s*(?:6|7|9|11)\b/i,
  /^\s*Killed\s*$/m,
  /core dumped/i,
];

const ERROR: readonly RegExp[] = [
  /\berror\b/i,
  // `npm ERR! code ELIFECYCLE` is npm's actual banner. The trailing `\b` after
  // `!` would never match -- `!` and the space after it are both non-word
  // characters, so there is no boundary there.
  /\berr(?:!|\b)/i,
  /\bexception\b/i,
  /\bstack trace\b/i,
  /\bfailed\b/i,
  /\bfailing\b/i,
  /\bfailure\b/i,
  /no such file or directory/i,
  /command not found/i,
  /permission denied/i,
  /\b(?:EACCES|ENOENT|EPERM|EISDIR|ENOTDIR|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b/,
];

const WARN: readonly RegExp[] = [
  /\bwarn(?:ing|ings)?\b/i,
  /\bdeprecat(?:ed|ion|ing)\b/i,
  /\bnote:\s/i,
];

const DEBUG: readonly RegExp[] = [/^\s*\[?debug\b/im, /\bdebug(?:ging|ged)?\b/i, /^\s*(?:-v\b|--verbose\b)/m];

const matchesAny = (line: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((p) => p.test(line));

/**
 * Severity of a single line. Exported because the truncate stage uses the same
 * predicate to decide which lines it must keep -- one classifier, so the two
 * cannot disagree about what an error is.
 */
export function lineSeverity(line: string): Severity {
  if (line.trim() === '') return 'info';
  if (MARKER_LINE.test(line)) return 'info';
  if (matchesAny(line, FATAL)) return 'fatal';
  if (matchesAny(line, ERROR) && !NEGATED_COUNT.test(line)) return 'error';
  if (matchesAny(line, WARN)) return 'warn';
  if (matchesAny(line, DEBUG)) return 'debug';
  return 'info';
}

/** True for the lines the truncate stage is forbidden to drop. */
export const isHighSeverityLine = (line: string): boolean =>
  severityAtLeast(lineSeverity(line), 'error');

const EXIT_CODE_PATTERNS: readonly RegExp[] = [
  /\bexit[_ ]?code\s*[:=]?\s*(\d{1,3})\b/i,
  /\bexit[_ ]?status\s*[:=]?\s*(\d{1,3})\b/i,
  /\bexited\s+with\s+(?:code\s+|status\s+)?(\d{1,3})\b/i,
  /\bexit(?:s|ed)?\s+(\d{1,3})\b/i,
];

export const classifyExitCode = (code: number): Severity => (code === 0 ? 'info' : 'error');

/** Best-effort exit code from raw output; undefined when the text carries none. */
export function extractExitCode(text: string): number | undefined {
  for (const p of EXIT_CODE_PATTERNS) {
    const match = p.exec(text);
    const captured = match?.[1];
    if (captured !== undefined) return Number.parseInt(captured, 10);
  }
  return undefined;
}

/**
 * Classify a whole tool result. `undefined` means "no opinion": the text was
 * absent or empty, so there is nothing to classify and the caller keeps whatever
 * severity it already had. An empty tool result is normal, not an error.
 */
export function classifySeverity(text: string | undefined): Severity | undefined {
  // Whitespace-only output is empty output. `"   \n\t"` from a command that
  // printed a blank line is the same case as `""`, and returning `info` for it
  // would write a severity onto a block that has no content to be severe about.
  if (text === undefined || text.trim() === '') return undefined;

  let worst: Severity = 'info';
  for (const line of text.split('\n')) worst = maxSeverity(worst, lineSeverity(line));

  const code = extractExitCode(text);
  if (code !== undefined) worst = maxSeverity(worst, classifyExitCode(code));
  return worst;
}

/**
 * Severity of a block as its *text* presents it, ignoring whatever `meta.severity`
 * already claims. Useful on its own when you want the text's opinion and nothing
 * else; `classifyBlockSeverity` is the one to call when you want the answer.
 */
export const classifyBlockText = (block: ContentBlock): Severity | undefined =>
  classifySeverity(block.text);

/**
 * The severity of a block, combining what the producer declared with what the
 * text implies under the never-downgrade rule: `error` and `fatal` stand, a lower
 * declared label is kept when the text is silent, and the text may only raise it.
 *
 * E-2 (the Claude Code PostToolUse hook) needs exactly this: one call, no chance
 * of relabelling an adapter-declared failure as `info` because its output
 * happened to be quiet.
 */
export function classifyBlockSeverity(block: ContentBlock): Severity | undefined {
  const declared = block.meta.severity;
  const inferred = classifySeverity(block.text);
  if (declared === undefined) return inferred;
  if (inferred === undefined) return declared;
  if (severityAtLeast(declared, 'error')) return declared;
  return maxSeverity(declared, inferred);
}

export interface SeverityReport {
  readonly classified: number;
  readonly raised: number;
  /** Blocks left alone because the adapter already called them error/fatal. */
  readonly deferredToProducer: number;
  /** Blocks with no text: nothing to classify. */
  readonly empty: number;
}

/**
 * Assign `meta.severity` to blocks that do not have a high severity yet.
 *
 * Two rules, both load-bearing:
 *
 * 1. Never downgrade. The ingress adapter sets `severity: 'error'` when the
 *    provider flagged `is_error`, and that is a fact about the tool call, not an
 *    inference from its output. A classifier that overwrote it with 'info'
 *    because the output text was tidy would quietly remove the retention
 *    guarantee that release gates G1/G3 rest on.
 * 2. Never promote *to* 'info' over an existing low severity is impossible by
 *    construction (there is nothing below the floor worth keeping), so the
 *    classifier may only fill in a block that has no severity at all, or raise
 *    one that is below 'error'.
 */
export function applySeverityClassification(ctx: LossyContext): {
  readonly ctx: LossyContext;
  readonly report: SeverityReport;
} {
  let classified = 0;
  let raised = 0;
  let deferred = 0;
  let empty = 0;

  const messages = ctx.messages.map((m) => {
    let touched = false;
    const content = m.content.map((b) => {
      const current = b.meta.severity;
      if (current === 'error' || current === 'fatal') {
        deferred += 1;
        return b;
      }
      const next = classifySeverity(b.text);
      if (next === undefined) {
        empty += 1;
        return b;
      }
      if (current === next) return b;
      classified += 1;
      if (current !== undefined) raised += 1;
      touched = true;
      return { ...b, meta: { ...b.meta, severity: next } };
    });
    return touched ? { ...m, content } : m;
  });

  if (classified === 0) {
    return { ctx, report: { classified: 0, raised: 0, deferredToProducer: deferred, empty } };
  }
  return {
    ctx: { ...ctx, messages },
    report: { classified, raised, deferredToProducer: deferred, empty },
  };
}
