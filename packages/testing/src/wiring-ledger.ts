/**
 * The wiring ledger: which exported operators have a production caller.
 *
 * ## Why this exists
 *
 * Between 2026-10-01 and 2026-10-02 this repo fixed five defects that a green
 * suite could not see: two independent B-3 pointer-ization defects, two gist
 * `raw_uri` producers that published a URI nothing had written, and the H-6
 * identity bug (49b93cb, f8a5549, 0243679, 18c30af). Every one of them lived in
 * a subsystem that was implemented, unit-tested, and **never executed by any
 * production path**:
 *
 * - `packages/pipeline/src/pointer.ts` -- no adapter assigns
 *   `meta.subject.kind === 'file'`; the anthropic, gemini and openai-compat
 *   adapters all assign `'other'`.
 * - `packages/gist` -- no package declares a dependency on `@strata-ctx/gist`.
 * - `packages/output-compress` -- `applyOutputCompression` has no caller.
 *
 * The suite was green *because* it tests operators directly. A unit test calls
 * the operator, so "implemented and tested" reads exactly like "working". This
 * module makes the difference a checked property instead of a judgement call.
 *
 * ## What it derives, and what it refuses to hand-maintain
 *
 * The inventory is walked out of the tree: barrels are followed, `export *` is
 * resolved, and every exported *runtime* value is checked for a reference from a
 * production source file. Nothing in this file lists operators, because a
 * hand-written list is the same drift being fixed -- it would go stale silently
 * and would still read as authoritative.
 *
 * The declarations live with the test (`../test/wiring-ledger.test.ts`), which
 * is where a gate belongs.
 *
 * ## The ruling: a self-reference is not wiring
 *
 * A symbol referenced only inside its own declaring file is called by nothing.
 * Before this was ruled, the ledger counted a single same-file `value`
 * reference as a caller and reported 432 of 1089 exports wired; with the ruling
 * it reports 152. The gap was almost entirely *transitive* liveness -- code
 * that does run, through a sibling function nothing outside the file names --
 * which is exactly the kind of finding a caller-count cannot make on its own.
 * The rules are enumerated on `isCallingSite`, which is where the decision is
 * made, and each one is asserted individually in the test.
 *
 * ## The three reachability questions, answered separately
 *
 * 1. **Is the module reachable?** From `packages/cli/src/index.ts` (the only
 *    `bin` in the workspace) and from the files the root `npm run dev` script
 *    names, following `import`/`export ... from` edges transitively. `dist/` is
 *    not an edge: a compiled copy of the same source is not a second caller.
 * 2. **Is the symbol referenced?** An identifier occurrence in a reachable
 *    source file that is not in the declaring file, not a barrel re-export, not
 *    a property key, not a member access, and not inside a comment or string.
 * 3. **Does the reference run?** Not answerable from source, and this module
 *    does not pretend otherwise -- see `WiringLedger.deadGates` in the test for
 *    the one case that *is* checkable, and docs/wiring-ledger.md for the rest.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/**
 * A source file the caller search is allowed to look at.
 *
 * `code` has comments *and* string bodies replaced by spaces, so a symbol named
 * in a JSDoc block or inside a URL is not a caller. `noComments` keeps string
 * bodies, because module specifiers only exist inside them and the barrel walk
 * needs to read them. Both variants preserve length and newlines, so an offset
 * or a line number means the same thing in either.
 *
 * This is the exclusion that decides the whole ledger, so it is stated rather
 * than implied: a mention in prose does not count, and neither does a mention
 * in a specifier.
 */
export interface ProductionFile {
  /** Absolute path. */
  readonly path: string;
  /** Repo-relative, POSIX-separated. Used in every message the ledger emits. */
  readonly rel: string;
  /** Owning package directory name, or `(root)` for `tools/`. */
  readonly module: string;
  readonly code: string;
  readonly noComments: string;
}

/**
 * What kind of occurrence it was. Only some kinds count as a caller, and the
 * ones that do not are listed individually because each was a real way to make
 * this ledger lie if it were folded into "found".
 */
export type ReferenceKind =
  /** `f(...)` */
  | 'call'
  /** `new F(...)` */
  | 'new'
  /** Any other value position: an argument, a table entry, a returned object. */
  | 'value'
  /** A name inside an `import { ... }` clause, with no application anywhere. */
  | 'import'
  /** A name inside an `export { ... }` clause. Re-exporting is not calling. */
  | 'reexport'
  /** The `export const/function/class` that declares it. */
  | 'declaration'
  /** `obj.f(...)` -- a property of something else, not this symbol. */
  | 'member'
  /** `readonly f: string`, `{ f: x }` -- a property key. */
  | 'propertykey'
  /** `typeof f`, or a name in a type-annotation position. Not a caller. */
  | 'typeonly';

export interface ReferenceSite {
  readonly file: string;
  readonly line: number;
  readonly kind: ReferenceKind;
}

/**
 * Confidence, best (strongest) evidence first. `import` is the weakest thing
 * that counts at all: `import { F } from './x.js'` with no application proves
 * the module was built, not that `F` ran. See docs/wiring-ledger.md.
 */
export type Confidence = 'call' | 'new' | 'value' | 'import' | 'none';

export interface LedgerEntry {
  readonly package: string;
  /** The exported name, or `namespace.member` for `export * as ns`. */
  readonly name: string;
  /** Repo-relative file the value is declared in (not the barrel). */
  readonly declaredIn: string;
  readonly wired: boolean;
  readonly confidence: Confidence;
  readonly siteCount: number;
  /** Up to `MAX_REPORTED_SITES` reachable-file sites, strongest first. */
  readonly sites: readonly ReferenceSite[];
  /** False when the declaring file is not reachable from any entry root. */
  readonly fileReachable: boolean;
}

export interface PackageReachability {
  readonly name: string;
  readonly reachable: boolean;
  /** Repo-relative modules of this package that are reachable. */
  readonly reachableModules: number;
  readonly totalModules: number;
  /** Repo-relative files outside this package that import it. */
  readonly consumers: readonly string[];
}

export interface WiringLedger {
  readonly root: string;
  readonly files: readonly ProductionFile[];
  /** Entry points the module graph starts from, with why each is one. */
  readonly roots: readonly { readonly file: string; readonly why: string }[];
  /** Repo-relative paths in the transitive `import` closure of `roots`. */
  readonly reachableFiles: readonly string[];
  readonly packages: readonly PackageReachability[];
  readonly entries: readonly LedgerEntry[];
  readonly wired: readonly LedgerEntry[];
  readonly unwired: readonly LedgerEntry[];
  /**
   * Unwired only because no module outside the package can reach it. Reported
   * separately so a whole-package gap is never confused with a per-operator one.
   */
  readonly inheritedUnwired: readonly LedgerEntry[];
  /** The subset of `unwired` inside a reachable package. These need one reason each. */
  readonly locallyUnwired: readonly LedgerEntry[];
}

const MAX_REPORTED_SITES = 3;

/* ------------------------------------------------------------------ *
 * 1. Locating the repository
 * ------------------------------------------------------------------ */

/**
 * Walk up for the workspace root rather than trusting `process.cwd()`: the test
 * runner's cwd is wherever the agent happened to be, and a ledger that changes
 * its answer with the cwd is a ledger that gets ignored.
 */
export function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    const manifest = join(dir, 'package.json');
    try {
      if (statSync(manifest).isFile() && readWorkspaces(manifest)) return dir;
    } catch {
      /* keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no npm-workspace root above ${start}`);
    dir = parent;
  }
}

function readWorkspaces(manifest: string): boolean {
  const parsed = parseJson(readFileSync(manifest, 'utf8'));
  return parsed !== undefined && Array.isArray(parsed.workspaces);
}

/** `JSON.parse` is typed `any`; every consumer here wants `unknown`. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) record[key] = value;
    return record;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Blanking comments and strings
 * ------------------------------------------------------------------ */

/**
 * Positions after which a `/` opens a regex rather than dividing. Getting this
 * wrong leaves regex *bodies* visible to the identifier search, which is how a
 * symbol comes to look wired because a pattern mentions it.
 */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

export interface BlankedSource {
  readonly code: string;
  readonly noComments: string;
}

export function blankNonCode(source: string): BlankedSource {
  const code = source.split('');
  const noComments = source.split('');
  const blank = (out: string[], from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = source.length;
  let i = 0;
  let prevChar = '';
  let prevWord = '';

  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1] ?? '';

    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && source[j] !== '\n') j++;
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = source.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(code, i, j);
      blank(noComments, i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) { j++; break; }
        // An unterminated quote is not a string, it is a typo; stop at the line
        // end so one bad character cannot blank the rest of the file.
        if (source[j] === '\n') break;
        j++;
      }
      blank(code, i, j);
      i = j;
      prevChar = 'x';
      prevWord = '';
      continue;
    }
    if (c === '`') {
      // The literal text of a template is blanked; its `${}` expressions are not,
      // because a symbol interpolated into a string is still evaluated.
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '`') { j++; break; }
        if (source[j] === '$' && source[j + 1] === '{') {
          blank(code, i, j);
          let depth = 1;
          let k = j + 2;
          while (k < n && depth > 0) {
            if (source[k] === '{') depth++;
            else if (source[k] === '}') depth--;
            if (depth === 0) break;
            k++;
          }
          j = k + 1;
          i = j;
          continue;
        }
        if (source[j] === '\n') blank(code, i, j + 1);
        else blank(code, i, j);
        j++;
      }
      blank(code, i, j);
      i = j;
      prevChar = 'x';
      prevWord = '';
      continue;
    }
    if (c === '/' && (prevChar === '' || REGEX_PRECEDERS.has(prevChar) || REGEX_KEYWORDS.has(prevWord))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = source[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(source[j] ?? '')) j++;
        blank(code, i, j);
        i = j;
        prevChar = 'x';
        prevWord = '';
        continue;
      }
    }

    if (!/\s/.test(c)) {
      prevChar = c;
      prevWord = /[\w$]/.test(c) ? prevWord + c : '';
    }
    i++;
  }
  return { code: code.join(''), noComments: noComments.join('') };
}

/* ------------------------------------------------------------------ *
 * 3. The file set, and exactly what is left out
 * ------------------------------------------------------------------ */

/**
 * Directories that are never sources. `dist/` is the important one: it holds a
 * compiled copy of every module, so leaving it in would make every symbol look
 * called by its own build output, and the ledger would report 100% wiring for a
 * repo where the gateway package is unreachable. The same is true of
 * `node_modules`, which holds 445 foreign export names.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

/**
 * A test is not a production path. `packages/<pkg>/test/**` is excluded whole,
 * not just `*.test.ts`, because `packages/eval/test/fixtures.ts` and
 * `packages/security/test/fixtures.ts` are helpers no test glob would match and
 * they import the operators directly.
 */
export function isTestPath(rel: string): boolean {
  return /(^|\/)test\//.test(rel) || /\.test\.ts$/.test(rel);
}

/**
 * Every `.ts` file under `packages/` and `tools/`, minus tests and build output.
 *
 * `tools/` is included because `npm run dev` is the only thing in the repo that
 * starts the gateway (`tools/dev.ts:46`, `createGateway`). `scripts/` is not: it
 * is `.mjs`, it is the contract gate, and no operator is reachable through it.
 */
export function collectProductionFiles(root: string): ProductionFile[] {
  const out: ProductionFile[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (entry.endsWith('.ts')) {
        const rel = relative(root, full).split('\\').join('/');
        if (isTestPath(rel)) continue;
        const { code, noComments } = blankNonCode(readFileSync(full, 'utf8'));
        out.push({ path: full, rel, module: moduleOf(rel), code, noComments });
      }
    }
  };
  visit(join(root, 'packages'));
  visit(join(root, 'tools'));
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

function moduleOf(rel: string): string {
  return /^packages\/([^/]+)\//.exec(rel)?.[1] ?? '(root)';
}

/** Directory names under `packages/`, sorted. The workspace is `packages/*`. */
export function workspacePackages(root: string): string[] {
  return readdirSync(join(root, 'packages'))
    .filter((name) => statSync(join(root, 'packages', name)).isDirectory())
    .sort();
}

/* ------------------------------------------------------------------ *
 * 4. The module graph and its entry roots
 * ------------------------------------------------------------------ */

const SPECIFIER_RE = /(?:from\s+|import\(\s*)'([^']+)'/g;

/**
 * Resolve an import specifier to a repo file, or null if it leaves the repo.
 *
 * `node:` builtins and bare third-party specifiers resolve to null on purpose:
 * this repo has no runtime dependencies outside `@strata-ctx/*` and `zod`, and
 * a package nobody imports locally is exactly what the package-level check in
 * `buildLedger` is for.
 */
function resolveSpecifier(
  root: string,
  from: string,
  spec: string,
  files: ReadonlyMap<string, ProductionFile>,
): string | null {
  if (spec.startsWith('.')) {
    const base = join(from, '..', spec).replace(/\.js$/, '.ts');
    if (files.has(base)) return base;
    const index = join(base, 'index.ts');
    return files.has(index) ? index : null;
  }
  const scoped = /^@strata-ctx\/([^/']+)/.exec(spec);
  if (!scoped) return null;
  const barrel = join(root, 'packages', scoped[1]!, 'src', 'index.ts');
  return files.has(barrel) ? barrel : null;
}

/** True when `spec` names `name` or anything inside it, by either import form. */
function specifierNames(root: string, spec: string, name: string): boolean {
  if (spec.startsWith('@strata-ctx/')) return spec === `@strata-ctx/${name}` || spec.startsWith(`@strata-ctx/${name}/`);
  const normalized = spec.split('\\').join('/');
  return new RegExp(`(?:^|/)packages/${name}/(?:src/)?(?:index\\.js|[\\w./-]+\\.js)$`).test(normalized) && !normalized.includes('node_modules/');
}

/**
 * Entry points, derived rather than declared.
 *
 * - every `bin` target in a workspace `package.json`, mapped `dist/` -> `src/`.
 *   `packages/cli/package.json:6` is the only one, and it is the whole product
 *   surface a user can reach without writing code.
 * - every `packages/**` or `tools/**` path named by a root npm script.
 *   `npm run dev` -> `tools/dev.ts`, which is the only gateway entry point.
 */
export function entryRoots(root: string, files: readonly ProductionFile[]): { file: string; why: string }[] {
  const byRel = new Map(files.map((f) => [f.rel, f.path]));
  const roots: { file: string; why: string }[] = [];

  // Walk the package directories rather than the `.ts` list: a manifest is not a
  // source file, and missing it here silently demotes the CLI from an entry
  // point, which takes `integrations` and `telemetry` down with it.
  for (const name of workspacePackages(root)) {
    const manifest = parseJson(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
    const bin = manifest?.['bin'];
    if (typeof bin !== 'object' || bin === null) continue;
    for (const target of Object.values(bin)) {
      if (typeof target !== 'string') continue;
      const rel = `packages/${name}/${target.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')}`;
      if (byRel.has(rel)) roots.push({ file: rel, why: `bin of @strata-ctx/${name}` });
    }
  }

  const rootManifest = parseJson(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts = rootManifest?.['scripts'];
  if (typeof scripts === 'object' && scripts !== null) {
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== 'string') continue;
      for (const m of cmd.matchAll(/(?:^|\s)((?:\.\.\/)?(?:packages|tools)\/[\w./-]+\.ts)/g)) {
        const rel = m[1]!.replace(/^\.\.\//, '');
        if (byRel.has(rel)) roots.push({ file: rel, why: `npm run ${name}` });
      }
    }
  }
  return roots.filter((r, i, all) => all.findIndex((x) => x.file === r.file) === i);
}

/** Transitive `import` closure of the entry roots. */
export function reachableModules(
  root: string,
  files: readonly ProductionFile[],
  roots: readonly { file: string }[],
): Set<string> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const byRel = new Map(files.map((f) => [f.rel, f.path]));
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const out = new Set<string>();
    for (const m of file.noComments.matchAll(SPECIFIER_RE)) {
      const target = resolveSpecifier(root, file.path, m[1]!, byPath);
      if (target) out.add(target);
    }
    edges.set(file.path, out);
  }
  const seen = new Set<string>();
  const stack = roots.map((r) => byRel.get(r.file)).filter((p): p is string => p !== undefined);
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dep of edges.get(next) ?? []) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/* ------------------------------------------------------------------ *
 * 5. Walking the barrels for exported runtime values
 * ------------------------------------------------------------------ */

export interface ExportSymbol {
  readonly package: string;
  readonly name: string;
  /** Absolute path of the declaring module, not of the barrel. */
  readonly file: string;
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return text.length;
}

const DECLARES = (name: string): RegExp =>
  new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:const|let|var|function|class|enum|async\\s+function)\\s+${escapeRe(name)}\\b`,
  );

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A declaration needs to start a line *or* follow a `;`. `packages/gist/src/index.ts`
 * ends without a trailing newline, so `export const x = 1` appended after its
 * last re-export lands on the same line -- and an anchored-at-line-start pattern
 * then misses a real export.
 */
const INLINE_DECL =
  /(^|[;\n])\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|enum|async\s+function)\s+([A-Za-z_$][\w$]*)/g;

/**
 * Every exported runtime value reachable from a package barrel.
 *
 * Deliberately excluded, and the exclusion is the point of the exercise rather
 * than an oversight: `export type` / `export interface` contribute no runtime
 * binding, so they cannot be "never executed". A dangling *type* is real drift
 * and nothing here catches it.
 */
export function collectExports(root: string, files: readonly ProductionFile[]): ExportSymbol[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const found: ExportSymbol[] = [];

  const visit = (path: string, ns: string, pkg: string, seen: Set<string>): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const info = byPath.get(path);
    if (!info) return;
    const text = info.noComments;

    for (const m of text.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+)'/g)) {
      const target = resolveSpecifier(root, path, m[2]!, byPath);
      if (target) visit(target, m[1]!, pkg, seen);
    }
    for (const m of text.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)) {
      const target = resolveSpecifier(root, path, m[1]!, byPath);
      if (target) visit(target, ns, pkg, seen);
    }
    // `export type { ... }` has no runtime binding. Skip the whole clause.
    for (const m of text.matchAll(/\bexport\s+type\s*\{/g)) matchBrace(text, m.index + m[0].length - 1);

    const clauseRe = /(^|[^.\w$])export\s+\{/g;
    let clause: RegExpExecArray | null;
    while ((clause = clauseRe.exec(text)) !== null) {
      const open = clause.index + clause[0].length - 1;
      const close = matchBrace(text, open);
      const fromMatch = /^from\s+'([^']+)'/.exec(text.slice(close + 1, close + 60).trimStart());
      const target = fromMatch ? resolveSpecifier(root, path, fromMatch[1]!, byPath) : null;
      const targetText = target ? byPath.get(target)?.noComments ?? '' : '';
      for (const spec of text.slice(open + 1, close).split(',')) {
        const parts = spec.trim().split(/\s+as\s+/);
        const local = parts[0] ?? '';
        const exported = (parts[1] ?? parts[0])?.trim() ?? '';
        if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
        // A rename proves the name exists in the target module; without it there
        // is no declaration to point at and the entry would be a guess.
        if (target) {
          if (!DECLARES(local).test(targetText)) continue;
          found.push({ package: pkg, name: ns ? `${ns}.${exported}` : exported, file: target });
        } else {
          found.push({ package: pkg, name: ns ? `${ns}.${exported}` : exported, file: path });
        }
      }
    }
    let decl: RegExpExecArray | null;
    INLINE_DECL.lastIndex = 0;
    while ((decl = INLINE_DECL.exec(text)) !== null) {
      found.push({ package: pkg, name: ns ? `${ns}.${decl[2]!}` : decl[2]!, file: path });
    }
  };

  const barrels = files.filter((f) => /\/src\/index\.ts$/.test(f.rel));
  for (const barrel of barrels) {
    const pkg = barrel.module;
    visit(barrel.path, '', pkg, new Set());
  }
  const deduped = new Map<string, ExportSymbol>();
  for (const sym of found) if (!deduped.has(`${sym.package}|${sym.name}`)) deduped.set(`${sym.package}|${sym.name}`, sym);
  return [...deduped.values()];
}

/* ------------------------------------------------------------------ *
 * 6. Classifying occurrences
 * ------------------------------------------------------------------ */

interface ClauseRange {
  readonly start: number;
  readonly end: number;
  readonly kind: ReferenceKind;
}

const CLAUSE_RE =
  /(^|[^.\w$])(import|export)\s+(?:type\s*\{|type\s+[A-Za-z_$][\w$]*|type\s|\*|\*?\s*\{|[A-Za-z_$][\w$]*\s+from\b)/g;

/**
 * Spans of `import`/`export` clauses, so a name can be told apart from the
 * clause that merely names it. Without this, every barrel re-exports every one
 * of its symbols and the ledger reports 100% wiring for the whole repo.
 */
function clauseRanges(text: string): ClauseRange[] {
  const out: ClauseRange[] = [];
  CLAUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAUSE_RE.exec(text)) !== null) {
    const start = m.index + m[1]!.length;
    const word = m[2]!;
    const after = text.slice(start + word.length).trimStart();
    const kind: ReferenceKind = /^type\b/.test(after)
      ? 'typeonly'
      : word === 'import'
        ? 'import'
        : 'reexport';
    let end = start;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (depth === 0 && (ch === ';' || ch === '\n')) { end = i; break; }
      end = i;
    }
    out.push({ start, end, kind });
    CLAUSE_RE.lastIndex = end;
  }
  return out;
}

/**
 * Positions that can only be a *type*, never a value.
 *
 * A bare `:` is deliberately absent. `{ run: applyTruncate }` and
 * `const x: SomeClass` are lexically identical, and this repo has 149 exported
 * names used in object shorthand -- `pipeline/src/truncate.ts:353` is one --
 * so treating every `key:` as a type position reported all of them unwired. A
 * gate that cries wolf on 149 entries gets muted, which is the fate AGENTS.md
 * §10 warns about for the `TOOL_ALIASES` checker. The cost of leaving `:` out
 * is that a class used *only* as a type looks wired; that is recorded as a known
 * false negative in docs/wiring-ledger.md rather than papered over.
 */
const TYPE_POSITION_RE =
  /(\btypeof\b|\bkeyof\b|\binfer\s|\bextends\b|\bimplements\b|\bsatisfies\b|\bas\s+[A-Za-z_$][\w$]*)\s*$/;
const BEFORE_WINDOW = 48;

/**
 * Every occurrence of `name`, classified. Only `call`, `new`, `value` and
 * `import` are callers; the rest are the ways a name can appear without one.
 *
 * `import` counts, but it is the weakest caller there is and the ledger reports
 * it as such: a name in an import clause with no application anywhere proves the
 * module compiled, not that the operator ran.
 */
export function referenceSites(
  files: readonly ProductionFile[],
  name: string,
  declaredIn: ReadonlySet<string>,
): ReferenceSite[] {
  const leaf = name.includes('.') ? name.split('.').pop()! : name;
  const ident = new RegExp(`(?<![\\w$.])${escapeRe(leaf)}(?![\\w$])`, 'g');
  const declares = DECLARES(leaf);
  const out: ReferenceSite[] = [];

  for (const file of files) {
    const ranges = clauseRanges(file.code);
    ident.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ident.exec(file.code)) !== null) {
      const at = m.index;
      const before = file.code.slice(Math.max(0, at - BEFORE_WINDOW), at);
      // Trailing whitespace is kept: the declaration pattern needs the separator
      // between the keyword and the name. The leading space guarantees the `\b`
      // in that pattern still has a boundary when the window starts mid-identifier.
      const declContext = ` ${before}${leaf}`;
      const tight = before.replace(/\s+$/, '');
      const after = file.code.slice(at + leaf.length, at + leaf.length + 48);
      let kind: ReferenceKind;
      if (/\.\s*$/.test(before)) kind = 'member';
      else if (declaredIn.has(file.path) && declares.test(declContext)) kind = 'declaration';
      else {
        const clause = ranges.find((r) => at >= r.start && at <= r.end);
        if (clause) kind = clause.kind;
        else if (/^\s*\??\s*:/.test(after) && /[{(,;]\s*$|readonly\s+$/.test(tight)) kind = 'propertykey';
        else if (/\bnew\s+$/.test(before)) kind = 'new';
        else if (TYPE_POSITION_RE.test(tight)) kind = 'typeonly';
        else if (/^\s*\(/.test(after)) kind = 'call';
        else kind = 'value';
      }
      out.push({ file: file.rel, line: file.code.slice(0, at).split('\n').length, kind });
    }
  }
  return out;
}

/**
 * Find occurrences of a *literal* pattern in code positions, with string bodies
 * intact.
 *
 * This exists because `blankNonCode` deletes string bodies, and a dead gate is
 * almost always expressed as a string: `kind: 'file'` is a data value, so the
 * only way to ask whether anything produces one is to search text the identifier
 * search has to erase.
 *
 * Searching `noComments` alone would also match prose such as
 * `const doc = "assign kind: 'file' first"`. A dead-gate pattern legitimately
 * spans a string literal -- that is the point -- so the test is not "does the
 * match touch a string" but "does it *begin* inside one": a match starting on a
 * blanked character is data, a match starting on code is a producer.
 *
 * Direction of failure: a false "the gate is open" makes the gate fail loudly
 * and a human deletes a declaration, which is recoverable. A false "the gate is
 * closed" hides a defect, which is not.
 */
export function findLiteralProducers(
  files: readonly ProductionFile[],
  pattern: RegExp,
): { file: string; line: number }[] {
  // The scan must be global and stateful, so `lastIndex` has to be reset per file.
  // A non-global `exec` restarts at 0 on every call and never terminates.
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const found: { file: string; line: number }[] = [];
  for (const file of files) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.noComments)) !== null) {
      const startsInString = file.code[m.index] !== file.noComments[m.index];
      if (!startsInString) {
        found.push({ file: file.rel, line: file.noComments.slice(0, m.index).split('\n').length });
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return found;
}

const CALLERS: ReadonlySet<ReferenceKind> = new Set<ReferenceKind>(['call', 'new', 'value', 'import']);
const RANK: Record<ReferenceKind, number> = {
  call: 6, new: 5, value: 4, import: 3, typeonly: 2, reexport: 1, propertykey: 0, declaration: 0, member: 0,
};

/**
 * Whether one reference is evidence that something calls the symbol.
 *
 * This is the whole "is it wired" decision, and it is stated rather than left to
 * fall out of a filter chain, because every clause below was a way for the
 * ledger to report an operator as wired when nothing runs it.
 *
 * The rules, in the order they apply:
 *
 * 1. **The reference must be in a caller-shaped position** -- `call`, `new`,
 *    `value` or `import`. A declaration, a re-export, a member access, a
 *    property key and a type position are not callers. Comments, strings and
 *    regex bodies never reach this function at all: `blankNonCode` erased them
 *    before the identifier search, so there is no site to judge.
 * 2. **A reference inside the module that declares the symbol is not a
 *    caller.** This is the ruling, and it is the clause that used to be
 *    missing. A symbol named only in its own declaring file is called by
 *    nothing, and the ledger's entire purpose is finding operators nobody
 *    calls. It applies to every kind, so a `value` in a table next to the
 *    declaration does not rescue it and neither does a `call` from a helper
 *    three functions below: a recursive operator that reaches itself, directly
 *    or through a same-file helper, stays unwired until a *different* file
 *    names it.
 * 3. **A reference in a module no entry root reaches is not a caller**, because
 *    nothing can get there. `packages/eval/src/*` referencing
 *    `packages/eval/src/*` is the case that made the first cut of this ledger
 *    useless.
 *
 * What rule 2 deliberately does *not* do is decide whether the operator
 * executes. A symbol read only by a sibling function in the same file, which
 * some other file then calls, does run -- and is still reported unwired,
 * because the ledger counts direct references and a grep-derived "wired" is not
 * proof in either direction. 109 of the 264 rows the ruling exposed are in
 * exactly that class -- each one's citing file imports the reader it names, or
 * the claim would not have been written down -- and every one of them says so
 * in its reason; see docs/wiring-ledger.md §6.
 *
 * The rule that is *not* here, and was asked for: a reference inside a sibling
 * file of the same package counts, and a reference inside the package's own
 * barrel counts when it is a real use rather than a re-export. Package
 * boundaries are not the test -- file boundaries are. `pointerizeBlocks` is
 * declared in `pointer.ts` and called from `truncate.ts:326`, and it stays
 * wired.
 */
export function isCallingSite(
  site: ReferenceSite,
  declaredIn: string,
  reachableFiles: ReadonlySet<string>,
): boolean {
  if (!CALLERS.has(site.kind)) return false;
  if (site.file === declaredIn) return false;
  return reachableFiles.has(site.file);
}

/* ------------------------------------------------------------------ *
 * 7. The ledger
 * ------------------------------------------------------------------ */

export function buildLedger(root: string): WiringLedger {
  const files = collectProductionFiles(root);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const roots = entryRoots(root, files);
  const reachable = reachableModules(root, files, roots);

  const exports = collectExports(root, files);
  const declaredFiles = new Map<string, Set<string>>();
  for (const sym of exports) {
    if (!declaredFiles.has(sym.name)) declaredFiles.set(sym.name, new Set());
    declaredFiles.get(sym.name)!.add(sym.file);
  }
  const reachableRel = new Set([...reachable].map((p) => byPath.get(p)?.rel ?? ''));

  const entries: LedgerEntry[] = exports.map((sym) => {
    const info = byPath.get(sym.file);
    const fileReachable = reachable.has(sym.file);
    const all = referenceSites(files, sym.name, declaredFiles.get(sym.name) ?? new Set());
    const sites = all
      .filter((s) => isCallingSite(s, info?.rel ?? sym.file, reachableRel))
      .sort((a, b) => RANK[b.kind] - RANK[a.kind]);
    const strongest = sites[0]?.kind;
    const confidence: Confidence =
      strongest === 'call' || strongest === 'new' || strongest === 'value' || strongest === 'import'
        ? strongest
        : 'none';
    return {
      package: sym.package,
      name: sym.name,
      declaredIn: info?.rel ?? sym.file,
      wired: sites.length > 0,
      confidence,
      siteCount: sites.length,
      sites: sites.slice(0, MAX_REPORTED_SITES),
      fileReachable,
    };
  });

  entries.sort((a, b) => (a.package === b.package ? (a.name < b.name ? -1 : 1) : a.package < b.package ? -1 : 1));

  const packageNames = [...new Set(files.filter((f) => f.module !== '(root)').map((f) => f.module))].sort();
  const packages: PackageReachability[] = packageNames.map((name) => {
    const own = files.filter((f) => f.module === name);
    const consumers = [
      ...new Set(
        files
          .filter((f) => f.module !== name)
          .filter((f) => [...f.noComments.matchAll(SPECIFIER_RE)].some((m) => specifierNames(root, m[1]!, name)))
          .map((f) => f.rel),
      ),
    ].sort();
    return {
      name,
      reachable: own.some((f) => reachable.has(f.path)),
      reachableModules: own.filter((f) => reachable.has(f.path)).length,
      totalModules: own.length,
      consumers,
    };
  });
  const reachablePackages = new Set(packages.filter((p) => p.reachable).map((p) => p.name));

  const wired = entries.filter((e) => e.wired);
  const unwired = entries.filter((e) => !e.wired);
  const inheritedUnwired = unwired.filter((e) => !reachablePackages.has(e.package));
  const locallyUnwired = unwired.filter((e) => reachablePackages.has(e.package));

  return {
    root,
    files,
    roots,
    reachableFiles: files.filter((f) => reachable.has(f.path)).map((f) => f.rel),
    packages,
    entries,
    wired,
    unwired,
    inheritedUnwired,
    locallyUnwired,
  };
}