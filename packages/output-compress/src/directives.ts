/**
 * H-4. Output directives.
 *
 * ## Why directives and not a rewriter
 *
 * docs/architecture.md §9: the response stream is pass-through, because output
 * tokens are emitted before anything can see them. TOON therefore lives at the
 * tool/MCP boundary, where a result is still a string we hold, and *verbosity*
 * is the only lever that survives to the response at all. The three directives
 * here are that lever.
 *
 * ## What they are not allowed to do
 *
 * They are prompt text. They are appended to a request, they are not injected
 * into a block, and they are never applied to governance content: a directive
 * that reached a pinned constraint would be a rewritable policy, and policy is
 * replace-only by construction (decisions ADR-5). `renderDirectives` returns a
 * string for the caller to put where it decides; this module has no access to
 * the context and therefore cannot get it wrong.
 *
 * Each directive is one or two imperative lines. A directive that needed a
 * paragraph would be a system prompt, and a system prompt that is four
 * sentences long gets followed for a week and then not at all.
 */

export type DirectiveId = 'no_preamble' | 'terse' | 'file_not_paste';

/**
 * Fixed order, always.
 *
 * Not cosmetic. Two runs with the same configuration must produce byte-identical
 * text (N6, determinism), and "the order the object literal happened to be in"
 * is not a specification. It also happens to be the order of increasing
 * intrusiveness: a reader who honours the first probably honours all three.
 */
export const DIRECTIVE_ORDER: readonly DirectiveId[] = Object.freeze([
  'no_preamble',
  'terse',
  'file_not_paste',
]);

export const DIRECTIVE_TEXT: Readonly<Record<DirectiveId, string>> = Object.freeze({
  no_preamble:
    'Answer directly. Do not restate the request, do not announce what you are about to do, and do not add a preamble.',
  terse:
    'Be terse. Omit narration, filler and restatements; keep the answer and the facts that support it.',
  file_not_paste:
    'Never paste file contents into the response. Refer to them as path:line instead, and read what you actually need.',
});

export interface DirectiveConfig {
  readonly no_preamble: boolean;
  readonly terse: boolean;
  readonly file_not_paste: boolean;
  /**
   * Caller-supplied lines, appended in order.
   *
   * Blank and whitespace-only lines are dropped rather than rendered: an empty
   * directive line is invisible to the model, costs a token, and makes a byte
   * comparison against a golden file fail for no reason.
   */
  readonly extra?: readonly string[];
}

export const NO_DIRECTIVES: DirectiveConfig = Object.freeze({
  no_preamble: false,
  terse: false,
  file_not_paste: false,
});

export interface RenderedDirectives {
  readonly text: string;
  readonly included: readonly DirectiveId[];
  /** Characters of `text`. Reported, not enforced: directives are not budgeted. */
  readonly bytes: number;
  readonly extraLines: number;
}

/**
 * Render the enabled directives, one per line, in `DIRECTIVE_ORDER`.
 *
 * Returns an empty string when nothing is enabled, and that is the only correct
 * answer: a request with no directives must be byte-identical to a request that
 * never called this function, or "the verbosity setting is off" would still cost
 * every user a system prompt.
 */
export function renderDirectives(config: DirectiveConfig): RenderedDirectives {
  const lines: string[] = [];
  const included: DirectiveId[] = [];

  for (const id of DIRECTIVE_ORDER) {
    if (!config[id]) continue;
    lines.push(DIRECTIVE_TEXT[id]);
    included.push(id);
  }

  let extraLines = 0;
  for (const raw of config.extra ?? []) {
    const line = raw.trim();
    if (line.length === 0) continue;
    lines.push(line);
    extraLines += 1;
  }

  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return Object.freeze({
    text,
    included: Object.freeze(included),
    bytes: text.length,
    extraLines,
  });
}

/** A single block of prompt text, for callers that want one string. */
export const directiveText = (config: DirectiveConfig): string => renderDirectives(config).text;

/**
 * The prose form of the same three rules.
 *
 * For the place a human reads them: a release note, a `--help` line, a review
 * comment. Kept next to the machine form on purpose, so the two cannot describe
 * different behaviour.
 */
export const DIRECTIVE_SUMMARY: Readonly<Record<DirectiveId, string>> = Object.freeze({
  no_preamble: 'skip the restatement and the "I will now ..."',
  terse: 'no narration, no filler, answer first',
  file_not_paste: 'cite path:line rather than pasting the file',
});
