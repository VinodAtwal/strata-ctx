/**
 * A deliberately small YAML reader.
 *
 * ## Why this exists at all
 *
 * A policy file is configuration the user hand-edits, and the plan calls for it
 * in YAML (docs/integrations.md §8). No YAML library is available to this
 * package, and adding one is not this stream's call, so this is a strict
 * *subset* reader rather than a general one. Everything it does not understand
 * it rejects with a line number, which is the only safe default for a document
 * whose job is to declare what the agent is forbidden to do: a parser that
 * quietly mis-reads `constraints:` is a parser that can quietly turn the
 * product's central safety claim off.
 *
 * ## What is supported
 *
 * Block mappings, block sequences, plain and quoted scalars, literal (`|`) and
 * folded (`>`) block scalars with chomping indicators, flow sequences and
 * mappings of scalars, `#` comments, one optional leading `---`, and the
 * YAML 1.2 core scalar types (string, integer, float, bool, null).
 *
 * ## What is rejected, and why each rejection matters
 *
 * - **Anchors and aliases** (`&a` / `*a`). Aliases are the billion-laughs
 *   denial-of-service against any recursive-descent YAML reader, and they are
 *   also how a file says "this text is the same object as that text" without
 *   saying what the text is.
 * - **Tags** (`!!python/...`, `!Foo`). Constructing arbitrary objects out of a
 *   policy file is not a thing this project should be able to do.
 * - **Multiple documents.** Which document is live is a decision, and this
 *   reader does not get to make it.
 * - **Tabs for indentation.** Ambiguous between indentation and content, and
 *   every second YAML bug report is someone's tab.
 * - **Duplicate keys.** YAML's default is last-one-wins. On a policy file, a
 *   duplicated `constraints:` key means the operator believes they wrote one
 *   thing and the process read another, which is precisely the invisible
 *   failure mode `.strict()` in the policy schema exists to prevent.
 * - **Leading-zero integers** are kept as strings. `id: 007` is an identifier,
 *   and silently turning it into `7` would change which constraint a user
 *   thinks they are editing.
 * - **Nested block mappings at the parent's indentation.** Real YAML allows
 *   ```yaml
 *   governance:
 *   pinning: required
 *   ```
 *   to mean `governance: { pinning: required }`, and refuses to guess which
 *   of the two blocks a user meant. Indent the nested block.
 *
 * Everything this reader produces is untrusted input that still has to survive
 * `StrataPolicySchema`, so a mis-parse surfaces as a schema error rather than
 * as a weakened policy.
 */

export class YamlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`policy YAML line ${line}: ${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface SourceLine {
  /** 1-based physical line number, for error messages. */
  readonly no: number;
  /** Number of leading spaces. -1 for a blank or comment-only line. */
  readonly indent: number;
  /** The line with comments stripped and trailing spaces removed. */
  readonly text: string;
  /**
   * The line with trailing spaces kept, indentation *included*. Block scalars
   * need the indentation because how much of it is stripped is itself part of
   * the value: in a literal block, indenting one line further indents its
   * content. Everything else should read `text` instead.
   */
  readonly raw: string;
}

const BLANK_INDENT = -1;

const isBlankish = (line: SourceLine): boolean => line.indent === BLANK_INDENT;

function stripComment(body: string, no: number): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // A '#' only opens a comment at the start of a token. `http://x#y` is a
    // scalar, not a scalar followed by a comment.
    if (ch === '#' && (i === 0 || body[i - 1] === ' ' || body[i - 1] === '\t')) {
      return body.slice(0, i);
    }
    if (ch === '\t' && i === 0) throw new YamlError('tabs may not be used for indentation', no);
  }
  if (quote !== null) throw new YamlError('unterminated quoted string', no);
  return body;
}

function scan(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  const rawLines = text.split(/\r?\n/);
  let seenDocumentStart = false;

  for (let i = 0; i < rawLines.length; i += 1) {
    const physical = rawLines[i] ?? '';
    const no = i + 1;

    if (physical.trim() === '') {
      out.push({ no, indent: BLANK_INDENT, text: '', raw: '' });
      continue;
    }

    const leading = /^[ ]*/.exec(physical)?.[0] ?? '';
    const body = physical.slice(leading.length);

    if (body.startsWith('\t')) throw new YamlError('tabs may not be used for indentation', no);
    if (body.startsWith('%')) throw new YamlError('YAML directives are not supported', no);
    if (body === '---' || body.startsWith('--- ')) {
      if (out.some((l) => !isBlankish(l))) throw new YamlError('multi-document YAML is not supported', no);
      if (seenDocumentStart) throw new YamlError('multi-document YAML is not supported', no);
      seenDocumentStart = true;
      out.push({ no, indent: BLANK_INDENT, text: '', raw: '' });
      continue;
    }
    if (body === '...') throw new YamlError('document end markers are not supported', no);
    if (body.startsWith('&') || body.startsWith('*')) {
      throw new YamlError('anchors and aliases are not supported', no);
    }
    if (body.includes('!')) throw new YamlError('tags are not supported', no);

    const text2 = stripComment(body, no);
    if (text2.trim() === '') {
      out.push({ no, indent: BLANK_INDENT, text: '', raw: '' });
      continue;
    }
    out.push({ no, indent: leading.length, text: text2.trimEnd(), raw: physical });
  }

  return out;
}

// The quoted-key alternatives come first: a plain-key pattern would match
// `"a` inside `"a:b": v` and silently produce a different key.
const KEY_SEP = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:][^:]*):( |$)/;

interface KeySplit {
  readonly key: string;
  readonly value: string;
}

function splitKey(text: string, no: number): KeySplit | null {
  const m = KEY_SEP.exec(text);
  if (m === null || m.index !== 0) return null;
  const key = m[1] ?? '';
  return { key: unquote(key, no), value: text.slice(key.length + 1).trim() };
}

function unquote(token: string, no: number): string {
  const first = token[0];
  if (first === '"' || first === "'") {
    if (token.length < 2 || !token.endsWith(first)) {
      throw new YamlError('unterminated quoted string', no);
    }
    const body = token.slice(1, -1);
    return first === "'" ? body.replace(/''/g, "'") : unescapeDouble(body, no);
  }
  return token;
}

const DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
};

function unescapeDouble(body: string, no: number): string {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const esc = body[i + 1];
    if (esc === undefined) throw new YamlError('dangling escape in a double-quoted string', no);
    if (esc === 'u') {
      const hex = body.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new YamlError('bad \\u escape', no);
      out += String.fromCharCode(Number.parseInt(hex, 16));
      // Five characters consumed from the backslash: the backslash itself, the
      // `u`, and four hex digits. The loop's own `i += 1` makes up the sixth, so
      // this has to stop one short of the first character after the escape --
      // one short of that and the last hex digit is emitted as literal text,
      // silently corrupting any policy value that contains an escape.
      i += 5;
      continue;
    }
    const mapped = DOUBLE_ESCAPES[esc];
    if (mapped === undefined) throw new YamlError(`unsupported escape \\${esc}`, no);
    out += mapped;
    i += 1;
  }
  return out;
}

const INT = /^-?(0|[1-9][0-9]*)$/;
const FLOAT = /^-?(0|[1-9][0-9]*)?\.[0-9]+([eE][-+]?[0-9]+)?$|^-?(0|[1-9][0-9]*)[eE][-+]?[0-9]+$/;
const LEADING_ZERO = /^-?0[0-9]+$/;

/**
 * YAML 1.2 core types only. `yes`/`no` stay strings: they are too ambiguous.
 *
 * The token is expected to be *unquoted*: quoting is resolved by `parseInline`
 * before it gets here, because a quote has to be matched before a value can be
 * known at all. `yes`/`no` are kept as strings for the same reason YAML 1.1
 * reading them as booleans is the single largest source of "why did my config
 * change" reports.
 */
export function coerceScalar(raw: string): string | number | boolean | null {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (LEADING_ZERO.test(s)) return s;
  if (INT.test(s)) return Number.parseInt(s, 10);
  if (FLOAT.test(s)) return Number.parseFloat(s);
  return s;
}

class Reader {
  private cursor = 0;
  private pending: SourceLine | null = null;

  constructor(private readonly lines: readonly SourceLine[]) {}

  /** The next structural line, or null at end of document. */
  peek(): SourceLine | null {
    if (this.pending !== null) return this.pending;
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (line !== undefined && !isBlankish(line)) return line;
      this.cursor += 1;
    }
    return null;
  }

  take(): SourceLine | null {
    // A pending line came from `unshift`, which re-injects a line the source
    // stream has already handed over. Serving it must not advance the cursor
    // and must clear it, or the same line is returned twice -- which surfaces
    // as a phantom "duplicate key" -- and a real line is skipped behind it.
    if (this.pending !== null) {
      const line = this.pending;
      this.pending = null;
      return line;
    }
    const line = this.peek();
    if (line !== null) this.cursor += 1;
    return line;
  }

  /** Re-inject a line the tokenizer already consumed (sequence-item mappings). */
  unshift(line: SourceLine): void {
    if (this.pending !== null) throw new Error('internal: a line is already pending');
    this.pending = line;
  }

  /** Raw lines of a block scalar body: everything more indented, blanks included. */
  blockBody(parentIndent: number): SourceLine[] {
    const body: SourceLine[] = [];
    while (this.cursor < this.lines.length) {
      const line = this.lines[this.cursor];
      if (line === undefined) break;
      if (!isBlankish(line) && line.indent <= parentIndent) break;
      body.push(line);
      this.cursor += 1;
    }
    while (body.length > 0 && isBlankish(body[body.length - 1] as SourceLine)) body.pop();
    return body;
  }

  document(): unknown {
    const first = this.peek();
    if (first === null) return null;
    const value = this.block(first.indent);
    const trailing = this.peek();
    if (trailing !== null) {
      throw new YamlError('unexpected content after the end of the document', trailing.no);
    }
    return value;
  }

  block(indent: number): unknown {
    const first = this.peek();
    if (first === null || first.indent < indent) return null;
    // A line that opens a mapping with nothing before the colon is a mapping
    // with no key, not a scalar that happens to start with a colon. Reading it
    // as a scalar would be the one class of mis-parse that turns a broken
    // policy file into a document that parses.
    if (first.text === ':' || first.text.startsWith(': ')) {
      throw new YamlError('empty key', first.no);
    }
    if (first.text === '-' || first.text.startsWith('- ')) return this.sequence(indent);
    if (splitKey(first.text, first.no) === null) return this.singleScalar(first);
    return this.mapping(indent);
  }

  /** A document (or a lone value under a key) that is just a scalar. */
  private singleScalar(first: SourceLine): unknown {
    this.take();
    if (first.text === '|' || first.text === '>' || /^[|>][-+]?[0-9]*$/.test(first.text)) {
      return this.blockScalar(first.text, first.indent);
    }
    return parseInline(first.text, first.no);
  }

  private mapping(indent: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('unexpected indentation', line.no);
      if (line.text === '-' || line.text.startsWith('- ')) {
        throw new YamlError('a sequence item cannot be a mapping key', line.no);
      }
      const split = splitKey(line.text, line.no);
      if (split === null) {
        throw new YamlError(`expected "key: value", got ${JSON.stringify(line.text)}`, line.no);
      }
      this.take();
      if (split.key === '') throw new YamlError('empty key', line.no);
      if (Object.hasOwn(map, split.key)) {
        throw new YamlError(`duplicate key ${JSON.stringify(split.key)}`, line.no);
      }
      if (split.key === '<<') throw new YamlError('merge keys are not supported', line.no);
      map[split.key] = this.value(split.value, indent, line.no);
    }
    return map;
  }

  private sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) break;
      if (line.indent > indent) throw new YamlError('unexpected indentation', line.no);
      if (line.text !== '-' && !line.text.startsWith('- ')) break;

      this.take();
      const rest = line.text === '-' ? '' : line.text.slice(2);
      const lead = rest.length - rest.trimStart().length;
      const body = rest.trim();

      if (body === '') {
        const next = this.peek();
        out.push(next !== null && next.indent > indent ? this.block(next.indent) : null);
        continue;
      }
      if (body === '-' || body.startsWith('- ')) {
        throw new YamlError('nested sequences on one line are not supported', line.no);
      }
      if (splitKey(body, line.no) !== null) {
        // `- id: c1` opens a mapping whose remaining keys line up with the
        // column the key started at, which is how YAML (and every human
        // writing a policy file) expects them to be indented:
        //
        //     constraints:
        //       - id: c1
        //         text: never delete production data
        //
        // `-` and the space after it are both part of the indent, so the item's
        // mapping starts at `line.indent + 2`, plus however much extra
        // whitespace the author used after the dash.
        const itemIndent = line.indent + 2 + lead;
        // `raw` is reconstructed rather than reused: the reader's `raw` is the
        // physical line, and this one never was, so the indent the item's
        // content sits at has to be put back to keep the two consistent.
        this.unshift({ no: line.no, indent: itemIndent, text: body, raw: ' '.repeat(itemIndent) + body });
        out.push(this.mapping(itemIndent));
        continue;
      }
      out.push(this.parseValue(body, indent, line.no));
    }
    return out;
  }

  private value(rest: string, indent: number, no: number): unknown {
    if (rest === '') {
      const next = this.peek();
      // A key with nothing after it and nothing nested under it is null, and
      // the policy schema rejects null where a list is required. That is
      // deliberate: `constraints:` with nothing under it must fail loudly
      // rather than quietly pinning nothing.
      if (next === null || next.indent < indent) return null;
      if (next.indent > indent) return this.block(next.indent);
      // Same indent, so it is a sibling, not a child. For a sequence item that
      // is ordinary YAML -- `items:` followed by `- a` at the same column -- and
      // it is read below. For a *mapping key* it is the ambiguous form the
      // module doc refuses to guess at:
      //
      //     governance:
      //     pinning: required
      //
      // Read as a child it is `governance: { pinning: required }`; read as a
      // sibling it is `governance: null` with a stray top-level `pinning`.
      // Both readings are plausible and they disagree about a safety setting,
      // so it is an error rather than a coin flip.
      const sibling = next.text === '-' || next.text.startsWith('- ');
      if (!sibling) {
        throw new YamlError(
          'a nested block at the same indentation as its key is ambiguous; indent it further',
          next.no,
        );
      }
      return this.sequence(indent);
    }
    return this.parseValue(rest, indent, no);
  }

  private parseValue(rest: string, indent: number, no: number): unknown {
    if (rest === '|' || rest === '>' || /^[|>]([-+]?[0-9]*|[-+]?)$/.test(rest)) {
      return this.blockScalar(rest, indent);
    }
    return parseInline(rest, no);
  }

  // No line number: a block scalar's body is only reachable if the header
  // parsed, and the header's own line is the one a reader would be sent to.
  private blockScalar(header: string, parentIndent: number): string {
    const style = header[0] === '|' ? 'literal' : 'folded';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = this.blockBody(parentIndent);
    if (body.length === 0) return chomp === 'keep' ? '\n' : '';

    const base = body.find((l) => !isBlankish(l))?.indent ?? parentIndent + 1;
    const lines = body.map((l) => (isBlankish(l) ? '' : (l.raw.slice(base).replace(/\s+$/, ''))));

    let out: string;
    if (style === 'literal') {
      out = lines.join('\n');
    } else {
      // Folded: consecutive non-empty lines join with a space, a blank line
      // becomes a newline. A paragraph break is the only way to keep a line
      // break in a folded scalar.
      const segments: string[] = [];
      let current = '';
      for (const l of lines) {
        if (l === '') {
          segments.push(current, '\n');
          current = '';
          continue;
        }
        current = current === '' ? l : `${current} ${l}`;
      }
      segments.push(current);
      out = segments.join('');
    }

    if (chomp === 'strip') return out.replace(/\n+$/, '');
    if (chomp === 'keep') return `${out}\n`;
    return out.endsWith('\n') ? out : `${out}\n`;
  }
}

/** Split on commas that are not inside a nested flow collection or a string. */
function splitFlow(body: string, no: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote !== null) {
      if (ch === '\\' && quote === '"') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i).trim());
      start = i + 1;
    }
    if (depth < 0) throw new YamlError('unbalanced flow collection', no);
  }
  if (quote !== null) throw new YamlError('unterminated quoted string', no);
  if (depth !== 0) throw new YamlError('unbalanced flow collection', no);
  const last = body.slice(start).trim();
  if (last !== '') parts.push(last);
  return parts;
}

function parseInline(text: string, no: number): unknown {
  const s = text.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('unterminated flow sequence', no);
    return splitFlow(s.slice(1, -1), no).map((p) => parseInline(p, no));
  }
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError('unterminated flow mapping', no);
    const out: Record<string, unknown> = {};
    for (const part of splitFlow(s.slice(1, -1), no)) {
      const split = splitKey(part, no);
      if (split === null) throw new YamlError(`expected "key: value" in a flow mapping`, no);
      if (Object.hasOwn(out, split.key)) throw new YamlError(`duplicate key ${JSON.stringify(split.key)}`, no);
      out[split.key] = parseInline(split.value, no);
    }
    return out;
  }
  if (s.startsWith('"') || s.startsWith("'")) return unquote(s, no);
  if (s.startsWith('*') || s.startsWith('&') || s.startsWith('!')) {
    throw new YamlError('anchors, aliases and tags are not supported', no);
  }
  return coerceScalar(s);
}

/**
 * Parse the supported subset. Throws {@link YamlError} on anything it does not
 * understand, including indentation it cannot account for.
 */
export function parseYaml(text: string): unknown {
  return new Reader(scan(text)).document();
}
