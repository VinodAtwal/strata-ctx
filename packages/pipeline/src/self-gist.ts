import type {
  GistDecision,
  GistNext,
  GistStatus,
  GistVerification,
  LossyContext,
  NonGovernanceBlock,
  PinIntegrity,
  Tier,
} from '@strata-ctx/core-types';
import { pinSetText, sha256, verifyPinIntegrity } from '@strata-ctx/core-types';
import type { TriggerDecision } from './trigger.js';

/**
 * B-8. Self-gist plumbing: the directive, the streaming parse, the draft.
 *
 * ## What this module is for
 *
 * F5 calls for the agent to write its own compression. That is Tier 2, and the
 * economics are the whole argument for it: the model already holds the state, so
 * a self-gist costs zero extra input tokens and zero extra latency, where a
 * summariser call (Tier 3, B-9) pays for a second context window. The cost is
 * that the summary is model-written, which makes two things non-negotiable:
 *
 * 1. **It must be a request, not an inference.** The model asks; we do not
 *    decide that a particular sentence *looks like* a summary. That is what
 *    `SELF_GIST_DIRECTIVE` is: an explicit sentinel pair, so a turn that merely
 *    discusses compaction produces nothing.
 * 2. **It must not be able to move policy.** `Gist.constraints` exists only as a
 *    byte-equality verification target (architecture §6), and a narrative block
 *    that could *carry* a constraint would turn that check into a tautology.
 *    So the summarisable region excludes governance, structurally and at
 *    runtime, and the pin set is copied in verbatim. See `buildSelfGistDraft`.
 *
 * ## Why the parse is streaming-first
 *
 * architecture §9: the response stream is pass-through, so the only thing that
 * may be held back is the tail after the sentinel. That is what
 * `SelfGistStreamScanner` is: a bounded ring buffer that forwards every byte
 * before the open sentinel immediately, retains only what a marker could still
 * straddle, and stops the moment the block closes. `SELF_GIST_TAIL_CHARS` is
 * derived from the markers rather than chosen, so adding a longer marker cannot
 * silently reintroduce the split-detection bug.
 *
 * The single-shot `parseSelfGistDirective` is the same parse without the buffer,
 * and it takes the retained tail explicitly so the two cannot disagree about
 * what "retained" means. Splitting a directive at any byte offset has to produce
 * the same answer as not splitting it; that is a property, not a hope, and
 * `self-gist.test.ts` sweeps every offset.
 *
 * ## Failures are quiet and they fail toward more context
 *
 * N5 and the transaction's step 4: abort, keep the transcript. So an unterminated
 * block is *reported* (`complete: false`) rather than thrown, an unrecognised
 * `status=` degrades to `partial` rather than discarding a whole gist, and an
 * orphan close sentinel is indistinguishable from no directive at all. Nothing
 * here can delete context; the worst outcome is a turn that does not compact.
 *
 * ## The one thing that does stop a draft
 *
 * Governance. A governance block inside the lossy range is structurally
 * impossible (`partitionForLossy` lifted it, and `NonGovernanceBlock` cannot
 * carry the tier) but a value can arrive by cast, which is why
 * `declaredTierOf` re-reads the tier at runtime the way `triageMessages` does.
 * Finding one means the lossy partition is not trustworthy, and the honest
 * response is to refuse the draft rather than summarise a range that may
 * contain policy.
 */

const ANGLE_OPEN = '<ctx-gist';
const ANGLE_CLOSE = '</ctx-gist>';
const FENCE_OPEN = '```ctx-gist';
const FENCE_CLOSE = '```';

const OPEN_MARKERS: Readonly<Record<SelfGistForm, string>> = Object.freeze({
  angle: ANGLE_OPEN,
  fence: FENCE_OPEN,
});

const CLOSE_MARKERS: Readonly<Record<SelfGistForm, string>> = Object.freeze({
  angle: ANGLE_CLOSE,
  fence: FENCE_CLOSE,
});

/**
 * Bytes held for an in-flight block before the scanner starts dropping its
 * middle. The architecture calls this "one small ring buffer"; the number is a
 * round 8kB so that a whole self-gist fits and a runaway block does not grow the
 * gateway's memory on the strength of one response. Dropping sets a defect, and
 * a defective draft never fires.
 */
export const SELF_GIST_RETAIN_CHARS = 8192;

/**
 * Bytes retained while *searching* for the open sentinel.
 *
 * Derived, never hand-written: a marker split across a chunk boundary is at
 * most one byte short of being found, so the search only ever needs the longest
 * marker minus one. Typing a number here would be a bug waiting for someone to
 * add a longer marker.
 */
export const SELF_GIST_TAIL_CHARS = Math.max(ANGLE_OPEN.length, FENCE_OPEN.length) - 1;

export type SelfGistForm = 'angle' | 'fence';

const GIST_STATUSES: readonly GistStatus[] = Object.freeze([
  'complete',
  'partial',
  'blocked',
  'abandoned',
]);

const isGistStatus = (v: string): v is GistStatus =>
  (GIST_STATUSES as readonly string[]).includes(v);

const VERIFICATION_STATUSES: readonly GistVerification['status'][] = Object.freeze([
  'untested',
  'passing',
  'failing',
  'inconclusive',
]);

/**
 * The markers a model emits to ask for its own gist, plus the prompt line that
 * tells it to (E-4 renders `instruction`; A-12 scans for the other four).
 *
 * Two open forms because the architecture says "fenced block" and agents write
 * both: the angle form is what a template can be precise about, and the fence
 * form is what a model produces when it has been told to write a code block. The
 * field grammar inside is identical for both, and identical to the one C-1's
 * assembler reads, because a self-gist that parses in B-8 and fails to parse in
 * C-1 is a gist that is written and then thrown away.
 */
export interface SelfGistMarkers {
  readonly open: string;
  readonly close: string;
  readonly fenceOpen: string;
  readonly fenceClose: string;
  /** Prompt text. Appended to a request; never injected into a block. */
  readonly instruction: string;
}

export const SELF_GIST_DIRECTIVE: SelfGistMarkers = Object.freeze({
  open: ANGLE_OPEN,
  close: ANGLE_CLOSE,
  fenceOpen: FENCE_OPEN,
  fenceClose: FENCE_CLOSE,
  instruction: [
    'When the task is finished, end your turn with one gist block, exactly:',
    '',
    `${ANGLE_OPEN} status=complete>`,
    'goal: what this turn was for',
    'decided: D1 - the choice you made (why: the reason) [rejected: the alternative | the other one]',
    'unresolved: the scary one that must survive',
    'next_question: what still has to be answered',
    'next_command: the next command to run',
    'blockers: what is stopping you',
    'tests_run: the tests you ran',
    'verification: passing | failing | inconclusive | untested',
    ANGLE_CLOSE,
    '',
    'Emit nothing else inside the block, and emit the block only when asked to.',
  ].join('\n'),
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                      */
/* -------------------------------------------------------------------------- */

export type SelfGistDefectKind =
  /** The stream ended (or the buffer filled) before the close sentinel. */
  | 'unterminated'
  /** A body with no field lines at all. */
  | 'empty_body'
  /** `status=` carried a value outside the schema enum. */
  | 'unknown_status'
  /** `verification:` carried a value outside the schema enum. */
  | 'unknown_verification'
  /** A `key: value` line whose key is not part of the grammar. */
  | 'unknown_field'
  /** A `decided:` line that did not carry an id and a choice. */
  | 'malformed_decision'
  /** The schema requires a non-empty `goal` and the block did not carry one. */
  | 'no_goal'
  /** A governance block was found inside the lossy range. */
  | 'governance_in_range'
  /** A governance block was found in the context and the pin set does not match it. */
  | 'pin_drift'
  /** The scanner dropped the middle of an over-long block. */
  | 'retain_truncated'
  /** An inverted `source_turn_range` was clamped. */
  | 'range_inverted';

export interface SelfGistDefect {
  readonly kind: SelfGistDefectKind;
  /** Never parsed as a field, never rendered. For telemetry and the test suite. */
  readonly detail: string;
}

const defect = (kind: SelfGistDefectKind, detail: string): SelfGistDefect => ({ kind, detail });

export interface SelfGistFields {
  readonly goal: string;
  readonly decided: readonly GistDecision[];
  readonly unresolved: readonly string[];
  readonly nextQuestion: string;
  readonly nextCommand: string;
  readonly blockers: readonly string[];
  readonly testsRun: readonly string[];
  readonly verification: GistVerification['status'];
}

const emptyFields = (): {
  goal: string;
  decided: GistDecision[];
  unresolved: string[];
  nextQuestion: string;
  nextCommand: string;
  blockers: string[];
  testsRun: string[];
  verification: GistVerification['status'];
} => ({
  goal: '',
  decided: [],
  unresolved: [],
  nextQuestion: '',
  nextCommand: '',
  blockers: [],
  testsRun: [],
  verification: 'untested',
});

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * `decided: D1 - the choice (why: the reason) [rejected: a | b]`
 *
 * Parsed in three steps rather than one regex because the last two brackets are
 * optional and the choice is free text that may itself contain a parenthesis.
 * The choice is what is left after the two marked groups are lifted out, so
 * "pick X (not Y) (why: it is faster)" keeps the whole choice.
 */
function parseDecision(value: string, defects: SelfGistDefect[]): GistDecision | null {
  const head = /^(\S+)\s*-\s*(.+)$/.exec(value);
  if (head === null) {
    defects.push(defect('malformed_decision', value));
    return null;
  }
  const id = head[1] ?? '';
  const rest = head[2] ?? '';
  const why = /\(why:\s*([^)]*)\)/.exec(rest)?.[1]?.trim() ?? '';
  const rejected = /\[rejected:\s*([^\]]*)\]/.exec(rest)?.[1] ?? '';
  const choice = rest
    .replace(/\(why:\s*[^)]*\)/, '')
    .replace(/\[rejected:\s*[^\]]*\]/, '')
    .trim();
  if (id.length === 0 || choice.length === 0) {
    defects.push(defect('malformed_decision', value));
    return null;
  }
  return {
    id,
    choice,
    why,
    alternatives_rejected: splitList(rejected.replace(/\|/g, ',')),
  };
}

function parseFields(body: string, defects: SelfGistDefect[]): SelfGistFields {
  const out = emptyFields();

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^([a-z_]+)\s*:\s*(.*)$/.exec(trimmed);
    if (match === null) {
      defects.push(defect('unknown_field', trimmed));
      continue;
    }
    const key = match[1] ?? '';
    const value = (match[2] ?? '').trim();

    switch (key) {
      case 'goal':
        if (out.goal.length === 0 && value.length > 0) out.goal = value;
        break;
      case 'decided': {
        const decision = parseDecision(value, defects);
        if (decision !== null) out.decided.push(decision);
        break;
      }
      case 'unresolved':
        if (value.length > 0) out.unresolved.push(value);
        break;
      case 'next_question':
        if (out.nextQuestion.length === 0 && value.length > 0) out.nextQuestion = value;
        break;
      case 'next_command':
        if (out.nextCommand.length === 0 && value.length > 0) out.nextCommand = value;
        break;
      case 'blockers':
        out.blockers.push(...splitList(value));
        break;
      case 'tests_run':
        out.testsRun.push(...splitList(value));
        break;
      case 'verification':
        if ((VERIFICATION_STATUSES as readonly string[]).includes(value)) {
          out.verification = value as GistVerification['status'];
        } else if (value.length > 0) {
          defects.push(defect('unknown_verification', value));
        }
        break;
      default:
        defects.push(defect('unknown_field', key));
        break;
    }
  }

  return out;
}

export interface SelfGistDirective {
  readonly form: SelfGistForm;
  /** The open sentinel that was matched. */
  readonly open: string;
  /** The close sentinel, or null when the block is still open. */
  readonly close: string | null;
  /** The directive as it arrived, sentinels included. */
  readonly raw: string;
  /** Between the sentinels, verbatim. This is what the model wrote. */
  readonly body: string;
  readonly fields: SelfGistFields;
  /** From `status=` on the open sentinel. `partial` when absent or unrecognised. */
  readonly status: GistStatus;
  /** False while the close sentinel is still outstanding. */
  readonly complete: boolean;
  readonly defects: readonly SelfGistDefect[];
}

/** Index of the `>` (angle) or the newline (fence) that ends the header line. */
function headerEndOf(raw: string, form: SelfGistForm): number {
  const at = form === 'angle' ? raw.indexOf('>') : raw.indexOf('\n');
  return at === -1 ? raw.length : at;
}

/**
 * `status=` is the only attribute the grammar has, and it is read from the open
 * sentinel rather than from the body: one place, no precedence rule, and a
 * duplicate key in the body cannot contradict the sentinel.
 */
function parseHeader(raw: string, form: SelfGistForm, defects: SelfGistDefect[]): GistStatus {
  const head = headerEndOf(raw, form);
  if (head >= raw.length) return 'partial';
  const header = raw.slice(OPEN_MARKERS[form].length, head);
  let status: GistStatus = 'partial';
  for (const token of header.trim().split(/\s+/)) {
    if (token.length === 0) continue;
    const eq = token.indexOf('=');
    const key = eq === -1 ? token : token.slice(0, eq);
    const value = eq === -1 ? '' : token.slice(eq + 1);
    if (key !== 'status') {
      defects.push(defect('unknown_field', key));
      continue;
    }
    if (!isGistStatus(value)) {
      defects.push(defect('unknown_status', value));
      continue;
    }
    status = value;
  }
  return status;
}

/**
 * The line break that ends the header and the one that starts the close
 * sentinel are separators, not content. Stripping exactly one of each is what
 * makes `body` the field grammar and nothing else, so `body` can be compared
 * against a template byte-for-byte.
 */
function trimSeparators(body: string): string {
  let start = 0;
  let end = body.length;
  if (body.startsWith('\r\n')) start = 2;
  else if (body.startsWith('\n')) start = 1;
  if (body.endsWith('\r\n')) end -= 2;
  else if (body.endsWith('\n')) end -= 1;
  return body.slice(start, Math.max(start, end));
}

function buildDirective(raw: string, form: SelfGistForm, complete: boolean): SelfGistDirective {
  const close = CLOSE_MARKERS[form];
  const head = headerEndOf(raw, form);
  const terminated = head < raw.length;
  const bodyStart = terminated ? head + 1 : raw.length;
  const inner = complete && raw.endsWith(close) ? raw.slice(bodyStart, raw.length - close.length) : raw.slice(bodyStart);
  const body = trimSeparators(inner);

  const defects: SelfGistDefect[] = [];
  if (!terminated) defects.push(defect('unterminated', `no header terminator in ${raw.length} chars`));
  if (!complete) defects.push(defect('unterminated', `no ${close} yet, ${raw.length} chars buffered`));
  const status = parseHeader(raw, form, defects);
  const fields = parseFields(body, defects);
  if (body.trim().length === 0) defects.push(defect('empty_body', 'no field lines between the sentinels'));
  if (fields.goal.length === 0) defects.push(defect('no_goal', 'the gist schema requires a non-empty goal'));

  return {
    form,
    open: OPEN_MARKERS[form],
    close: complete ? close : null,
    raw,
    body,
    fields,
    status,
    complete,
    defects,
  };
}

interface OpenMatch {
  readonly at: number;
  readonly form: SelfGistForm;
}

/** Earliest open sentinel wins; on a tie the longer marker wins. */
function locateOpen(text: string): OpenMatch | null {
  let best: OpenMatch | null = null;
  for (const form of ['angle', 'fence'] as const) {
    const at = text.indexOf(OPEN_MARKERS[form]);
    if (at === -1) continue;
    if (best === null || at < best.at) best = { at, form };
  }
  return best;
}

export interface ParseSelfGistOptions {
  /**
   * The tail a previous chunk retained. Prepended to `text` before scanning, so
   * a caller driving the parse by hand gets the same answer the scanner gets.
   */
  readonly carried?: string;
}

/**
 * Scan `text` for a self-gist directive. Returns `null` when there is no open
 * sentinel, which is the common case and the one that must be cheap.
 *
 * An open sentinel with no close sentinel yet returns a directive with
 * `complete: false` rather than `null`: the stream is not finished, and calling
 * that "absent" would make a caller that flushes early silently lose the block.
 * An orphan *close* sentinel is the reverse and returns `null` -- there is
 * nothing to report, and inventing a directive for it would let any text ending
 * in a fence trigger compaction.
 */
export function parseSelfGistDirective(
  text: string,
  options: ParseSelfGistOptions = {},
): SelfGistDirective | null {
  const buf = `${options.carried ?? ''}${text}`;
  const open = locateOpen(buf);
  if (open === null) return null;

  const rest = buf.slice(open.at + OPEN_MARKERS[open.form].length);
  const closeAt = rest.indexOf(CLOSE_MARKERS[open.form], headerEndOf(rest, open.form));
  if (closeAt === -1) return buildDirective(buf.slice(open.at), open.form, false);
  return buildDirective(
    buf.slice(open.at, open.at + OPEN_MARKERS[open.form].length + closeAt + CLOSE_MARKERS[open.form].length),
    open.form,
    true,
  );
}

/**
 * The tail a caller must carry into the next `parseSelfGistDirective` call.
 *
 * Two states, and the difference is the whole contract: before an open sentinel
 * has been seen, only the last `SELF_GIST_TAIL_CHARS` characters can still
 * become part of one; after it has, everything from the marker onward is part
 * of the block and dropping any of it loses the close sentinel. The scanner
 * does this internally; this is the same rule for a caller driving the
 * single-shot parse by hand.
 */
export function retainTail(text: string, carried = ''): string {
  const buf = `${carried}${text}`;
  const open = locateOpen(buf);
  if (open !== null) return buf.slice(open.at);
  return buf.length <= SELF_GIST_TAIL_CHARS ? buf : buf.slice(buf.length - SELF_GIST_TAIL_CHARS);
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                    */
/* -------------------------------------------------------------------------- */

export interface SelfGistScan {
  /** Safe to forward to the client now. Never contains a byte after the sentinel. */
  readonly forward: string;
  /** Carry into the next `push`. */
  readonly retain: string;
  /** Non-null once the open sentinel has been seen. */
  readonly directive: SelfGistDirective | null;
  /** True once the block has closed. */
  readonly complete: boolean;
  /** Characters currently held. The bound the architecture asks about. */
  readonly buffered: number;
  /** The scanner dropped the middle of an over-long block. */
  readonly truncated: boolean;
}

export interface SelfGistScannerOptions {
  /** Cap for an in-flight block. Defaults to `SELF_GIST_RETAIN_CHARS`. */
  readonly retainChars?: number;
}

/**
 * The A-12 ring buffer, in the smallest form that can carry a gist.
 *
 * Three states, and the transitions are the whole implementation:
 *
 * - **searching** -- nothing is retained beyond `SELF_GIST_TAIL_CHARS`, so
 *   time-to-first-token is unaffected (N3) and a turn that never emits a
 *   directive costs a `indexOf` per chunk.
 * - **open** -- everything is retained and nothing is forwarded, because the
 *   block is not yet a block. Bounded by `retainChars`; past the bound the
 *   middle is dropped, `truncated` goes true, and a defective draft never fires.
 * - **done** -- the close sentinel was found; everything afterwards is forwarded
 *   untouched and the scanner is inert.
 */
export class SelfGistStreamScanner {
  readonly #limit: number;
  #carry = '';
  #directive: SelfGistDirective | null = null;
  #done = false;
  #truncated = false;

  constructor(options: SelfGistScannerOptions = {}) {
    this.#limit = Math.max(OPEN_MARKERS.angle.length, options.retainChars ?? SELF_GIST_RETAIN_CHARS);
  }

  get done(): boolean {
    return this.#done;
  }

  get buffered(): number {
    return this.#carry.length;
  }

  push(chunk: string): SelfGistScan {
    if (this.#done) {
      // The block is already whole; the rest of the response is ordinary prose.
      return { forward: chunk, retain: '', directive: this.#directive, complete: true, buffered: 0, truncated: this.#truncated };
    }

    const buf = this.#carry + chunk;
    let head = 0;
    let opened = false;

    if (this.#directive === null) {
      const open = locateOpen(buf);
      if (open === null) {
        const at = buf.length - Math.min(buf.length, SELF_GIST_TAIL_CHARS);
        this.#carry = buf.slice(at);
        return { forward: buf.slice(0, at), retain: this.#carry, directive: null, complete: false, buffered: this.#carry.length, truncated: false };
      }
      head = open.at;
      this.#carry = buf.slice(head);
      this.#directive = buildDirective(this.#carry, open.form, false);
      opened = true;
    } else {
      // Everything from the open marker onwards is retained, and the new chunk
      // is part of it. Without this the bytes between the last push and the
      // close sentinel are silently dropped, which is only visible at the
      // chunk sizes where the open marker happens to land on a boundary.
      this.#carry = buf;
    }

    const form = this.#directive.form;
    // The close sentinel can never start inside the open one: `<ctx-gist` does
    // not contain `</ctx-gist>`, and the fence open *is* a run of backticks.
    // So the search starts just past the open marker rather than at a body
    // offset computed on an earlier chunk -- the header terminator may not have
    // arrived yet, and a stale offset is how a close sentinel goes missing at
    // one-character chunk sizes.
    const from = Math.min(OPEN_MARKERS[form].length, this.#carry.length);
    const closeAt = this.#carry.indexOf(CLOSE_MARKERS[form], from);

    if (closeAt === -1) {
      if (this.#carry.length > this.#limit) {
        this.#carry = this.#carry.slice(this.#carry.length - this.#limit);
        this.#truncated = true;
      }
      return { forward: opened ? buf.slice(0, head) : '', retain: this.#carry, directive: this.#directive, complete: false, buffered: this.#carry.length, truncated: this.#truncated };
    }

    const raw = this.#carry.slice(0, closeAt + CLOSE_MARKERS[form].length);
    this.#directive = buildDirective(raw, form, true);
    this.#done = true;
    const rest = this.#carry.slice(raw.length);
    this.#carry = '';
    return {
      forward: (opened ? buf.slice(0, head) : '') + rest,
      retain: '',
      directive: this.#directive,
      complete: true,
      buffered: 0,
      truncated: this.#truncated,
    };
  }

  /**
   * End of stream. Whatever is still retained is parsed and reported; an
   * unterminated block comes back `complete: false`, which is the whole point
   * of flushing rather than guessing.
   */
  flush(): SelfGistScan {
    const carry = this.#carry;
    this.#carry = '';
    const directive = this.#directive ?? (carry.length > 0 ? parseSelfGistDirective(carry) : null);
    return {
      forward: '',
      retain: '',
      directive,
      complete: this.#done,
      buffered: 0,
      truncated: this.#truncated,
    };
  }
}

export const createSelfGistScanner = (options?: SelfGistScannerOptions): SelfGistStreamScanner =>
  new SelfGistStreamScanner(options);

/* -------------------------------------------------------------------------- */
/* The draft                                                                    */
/* -------------------------------------------------------------------------- */

export type TurnRange = readonly [number, number];

const ALL_TIERS: readonly Tier[] = Object.freeze([
  'governance',
  'episodic',
  'tool_state',
  'artifact_ref',
  'user_intent',
]);

/**
 * Reading a `NonGovernanceBlock`'s tier at runtime.
 *
 * The compiler has already proved this cannot be 'governance', so the
 * comparison has to be made against the wider union for the runtime value to be
 * examinable at all. Same reading, same fallback, as `declaredTier` in
 * ./triage.ts: a phantom value is treated as `episodic`, which keeps it visible
 * to the compactor rather than quietly dropping it.
 */
const declaredTierOf = (b: NonGovernanceBlock): Tier =>
  (ALL_TIERS as readonly string[]).includes(b.meta.tier) ? b.meta.tier : 'episodic';

const isGovernanceBlock = (b: NonGovernanceBlock): boolean => declaredTierOf(b) === 'governance';

const heldText = (ctx: LossyContext): string[] =>
  ctx.held.map((h) => h.block.text ?? '').filter((t) => t.length > 0);

/**
 * Remove every pinned constraint from text a model produced.
 *
 * Not belt-and-braces paranoia: the model was shown the constraints, so it can
 * quote one back, and a constraint inside a summarisable region becomes a
 * constraint the compactor can paraphrase. A gist that *restates* policy is
 * policy with no provenance, which is exactly what `Gist.constraints` being a
 * verification target is designed to prevent.
 */
export function stripGovernance(text: string, held: readonly string[]): string {
  let out = text;
  for (const raw of held) {
    const needle = raw.trim();
    if (needle.length === 0) continue;
    out = out.replaceAll(needle, '');
  }
  return out;
}

export interface SelfGistNarrative {
  readonly goal: string;
  readonly decided: readonly GistDecision[];
  readonly unresolved: readonly string[];
  readonly next: GistNext;
  readonly verification: GistVerification;
}

/** The fields the schema calls narrative, lifted to the schema's own shapes. */
export function narrativeFrom(directive: SelfGistDirective | null): SelfGistNarrative {
  const fields = directive?.fields ?? emptyFields();
  return {
    goal: fields.goal,
    decided: [...fields.decided],
    unresolved: [...fields.unresolved],
    next: {
      question: fields.nextQuestion,
      next_command: fields.nextCommand,
      blockers: [...fields.blockers],
    },
    verification: { tests_run: [...fields.testsRun], status: fields.verification },
  };
}

/**
 * The compactor's working set for one self-gist: what the summariser would be
 * given, what the pin comparison said, and every defect found on the way.
 *
 * Deliberately *not* the contract's `GistDraft`. That is a `Gist` with the
 * recoverability claim left off -- the document the transaction commits -- and
 * this is the input to building it: camelCase, a message range rather than a
 * turn range, the digest of the summable text, and a defect list rather than a
 * stored-bytes claim. It shipped under the name `GistDraft` anyway, as did the
 * PreCompact handoff document (integrations/src/claude-code-observers.ts) and
 * the model-writable block (integrations/src/templates.ts); three shapes, no
 * shared field, one name.
 */
export interface SelfGistDraft {
  /** Mirrors `Gist.v`. A draft is not a gist; it is the input to one. */
  readonly v: 1;
  readonly taskId: string;
  readonly turn: number;
  readonly status: GistStatus;
  readonly goal: string;
  /** Message indices the draft is built from. What step 7 asserts against. */
  readonly sourceTurnRange: TurnRange;
  /**
   * The pin set, copied verbatim from policy and frozen.
   *
   * Not model-written, not reordered, not merged with anything the model said.
   * This array exists so that step 4c is a byte comparison against a value the
   * compactor had no way to influence.
   */
  readonly constraints: readonly string[];
  /** The same comparison C-1 runs, reported rather than thrown. */
  readonly pinIntegrity: PinIntegrity;
  readonly narrative: SelfGistNarrative;
  /** The raw text handed to the summariser. Contains no governance. */
  readonly text: string;
  readonly textChars: number;
  readonly textDigest: string;
  /** Indices inside the range that contributed at least one block. */
  readonly summableMessages: readonly number[];
  readonly summableBlocks: number;
  /** Governance found in the range and kept out. Structurally always 0. */
  readonly governanceExcluded: number;
  readonly defects: readonly SelfGistDefect[];
}

export interface BuildSelfGistDraftInput {
  readonly ctx: LossyContext;
  readonly directive?: SelfGistDirective | null;
  /** Defaults to every message in the lossy context. */
  readonly sourceTurnRange?: TurnRange;
  readonly status?: GistStatus;
  /** Used when the context has no `taskId`. */
  readonly taskId?: string;
  /**
   * Overrides the region derived from `ctx`. Still stripped of governance:
   * the caller usually passes the model's own response text, and the model has
   * read the pin set.
   */
  readonly text?: string;
}

interface Region {
  readonly text: string;
  readonly messages: readonly number[];
  readonly blocks: number;
  readonly governanceExcluded: number;
}

const EMPTY_REGION: Region = Object.freeze({
  text: '',
  messages: Object.freeze([]),
  blocks: 0,
  governanceExcluded: 0,
});

function clampRange(
  requested: TurnRange,
  count: number,
  defects: SelfGistDefect[],
): TurnRange {
  if (count === 0) return [0, 0];
  const lo = Math.max(0, Math.min(count - 1, Math.min(requested[0], requested[1])));
  const hi = Math.max(0, Math.min(count - 1, Math.max(requested[0], requested[1])));
  if (requested[0] > requested[1]) {
    defects.push(defect('range_inverted', `[${requested[0]}, ${requested[1]}] -> [${lo}, ${hi}]`));
  }
  return [lo, hi];
}

/**
 * The text a summariser is allowed to see: the text blocks in the range, with
 * every governance block removed twice over -- once because the tier says so,
 * and once because `stripGovernance` deletes any constraint text that survived
 * inside a non-governance block.
 */
function summableRegion(
  ctx: LossyContext,
  range: TurnRange,
  held: readonly string[],
): Region {
  const parts: string[] = [];
  const messages: number[] = [];
  let blocks = 0;
  let governanceExcluded = 0;

  for (let i = range[0]; i <= range[1] && i < ctx.messages.length; i += 1) {
    const m = ctx.messages[i];
    if (m === undefined) continue;
    let took = 0;
    for (const b of m.content) {
      if (isGovernanceBlock(b)) {
        governanceExcluded += 1;
        continue;
      }
      const text = b.text;
      if (text === undefined || text.length === 0) continue;
      parts.push(text);
      took += 1;
    }
    blocks += took;
    if (took > 0) messages.push(i);
  }

  return {
    text: stripGovernance(parts.join('\n\n'), held),
    messages,
    blocks,
    governanceExcluded,
  };
}

/**
 * Build the draft: what the compactor would write, before anything has been
 * validated or committed.
 *
 * The function is total. It does not throw when the range is inverted, when the
 * pin set has drifted, or when a governance block arrived by cast: each of those
 * is a fact about the turn, recorded in `defects` for step 4 to act on, because
 * the transaction's contract is to abort and keep the transcript rather than to
 * fail earlier and lose it.
 */
export function buildSelfGistDraft(input: BuildSelfGistDraftInput): SelfGistDraft {
  const { ctx, directive = null } = input;
  const defects: SelfGistDefect[] = [...(directive?.defects ?? [])];

  const held = heldText(ctx);
  const constraints = Object.freeze(pinSetText(ctx.policy));
  const pinIntegrity = verifyPinIntegrity(constraints, held);
  if (!pinIntegrity.ok) {
    const kinds = pinIntegrity.defects.map((d) => d.kind).join(',');
    defects.push(defect('pin_drift', kinds));
  }

  const requested: TurnRange =
    input.sourceTurnRange ?? [0, Math.max(0, ctx.messages.length - 1)];
  const range = clampRange(requested, ctx.messages.length, defects);

  // An override still gets the message census and still gets stripped: the
  // caller usually hands in the model's own response text, and the model has
  // read the pin set.
  const region = input.text === undefined ? summableRegion(ctx, range, held) : EMPTY_REGION;
  const text = stripGovernance(input.text ?? region.text, held);
  if (region.governanceExcluded > 0) {
    defects.push(defect('governance_in_range', `${region.governanceExcluded} block(s) held out`));
  }

  const narrative = narrativeFrom(directive);

  return {
    v: 1,
    taskId: input.taskId ?? ctx.taskId ?? `turn-${ctx.turn}`,
    turn: ctx.turn,
    status: input.status ?? directive?.status ?? 'partial',
    goal: narrative.goal,
    sourceTurnRange: range,
    constraints,
    pinIntegrity,
    narrative,
    text,
    textChars: text.length,
    textDigest: sha256(text),
    summableMessages: region.messages,
    summableBlocks: region.blocks,
    governanceExcluded: region.governanceExcluded,
    defects,
  };
}

/* -------------------------------------------------------------------------- */
/* The decision                                                                 */
/* -------------------------------------------------------------------------- */

export type SelfGistSignal = 'size_backstop' | 'task_boundary';

export type SelfGistReason =
  | 'size_backstop'
  | 'sawtooth_task_boundary'
  | 'disabled'
  | 'no_directive'
  | 'directive_incomplete'
  | 'governance_in_range'
  | 'no_summable_text'
  | 'compaction_off'
  | 'compaction_manual'
  | 'awaiting_task_boundary'
  | 'below_soft';

export interface SelfGistDecision {
  readonly fire: boolean;
  /** Machine-readable, for telemetry (`compaction.trigger`). */
  readonly reason: SelfGistReason;
  readonly signals: readonly SelfGistSignal[];
  readonly tokens: number;
  readonly utilization: number;
  readonly turn: number;
  readonly sourceTurnRange: TurnRange;
}

/**
 * B-7's vocabulary, restated as a self-gist signal.
 *
 * The two signals are the only two ways a self-gist may ever be justified: the
 * size backstop, which is a safety valve, and the sawtooth boundary, which is
 * the moment compaction is nearly free. Everything else B-7 can say -- a soft
 * limit not yet reached, a boundary seen early, compaction switched off -- is a
 * hold.
 */
function signalsFor(trigger: TriggerDecision): readonly SelfGistSignal[] {
  switch (trigger.reason) {
    case 'hard_limit':
    case 'hard_limit_misordered':
    case 'soft_limit':
      return ['size_backstop'];
    case 'soft_limit_at_boundary':
      return ['task_boundary'];
    default:
      return [];
  }
}

const HELD_REASON: Readonly<Record<string, SelfGistReason>> = Object.freeze({
  compaction_off: 'compaction_off',
  compaction_manual: 'compaction_manual',
  awaiting_task_boundary: 'awaiting_task_boundary',
  below_soft: 'below_soft',
  below_soft_at_boundary: 'below_soft',
});

export interface ShouldSelfGistInput {
  readonly draft: SelfGistDraft;
  readonly directive: SelfGistDirective | null;
  /** The B-7 decision for this turn. Not recomputed here. */
  readonly trigger: TriggerDecision;
  /** Session kill switch. Defaults to true; the policy has its own (`off`/`manual`). */
  readonly enabled?: boolean;
}

/**
 * Fire only when both halves are present: a real request from the model *and* a
 * real trigger signal from B-7.
 *
 * The conjunction is the entire point. A directive alone fires on every turn a
 * chatty model decides to summarise itself, which is a compaction per turn and
 * a transcript that has been through a lossy stage far more often than the
 * evidence supports. A trigger alone fires on prose that happens to have
 * crossed the soft limit mid-task, which is the Compaction Cliff with extra
 * steps. Ordinary prose fails the first half, and the test suite says so.
 */
export function shouldSelfGist(input: ShouldSelfGistInput): SelfGistDecision {
  const { draft, directive, trigger } = input;
  const base = {
    signals: signalsFor(trigger),
    tokens: trigger.tokens,
    utilization: trigger.utilization,
    turn: draft.turn,
    sourceTurnRange: draft.sourceTurnRange,
  };
  const hold = (reason: SelfGistReason): SelfGistDecision => ({ fire: false, reason, ...base });

  if (input.enabled === false) return hold('disabled');
  // First, because it is the only check whose failure means the rest of the
  // inputs cannot be trusted at all.
  if (draft.governanceExcluded > 0) return hold('governance_in_range');
  if (directive === null) return hold('no_directive');
  if (!directive.complete) return hold('directive_incomplete');
  if (draft.text.length === 0) return hold('no_summable_text');
  if (!trigger.fire) return hold(HELD_REASON[trigger.reason] ?? 'below_soft');

  return {
    fire: true,
    reason: base.signals.includes('task_boundary') ? 'sawtooth_task_boundary' : 'size_backstop',
    ...base,
  };
}
