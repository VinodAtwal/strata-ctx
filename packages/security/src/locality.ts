import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/**
 * I-4: the locality guarantee, as code.
 *
 * ## The claim
 *
 * N4: "all context/gists/artifacts stay on disk; no telemetry egress by
 * default". The product statement leans on it: it is a *proxy*, not a service,
 * so there is nowhere for the context to go. That claim is only worth anything
 * if it cannot rot quietly, and it rots quietly in three ways:
 *
 *   1. someone adds `undici` to a future commit;
 *   2. someone reaches for `fetch` in a "quick health check";
 *   3. someone adds a dependency that *has* a client, so the package.json looks
 *      clean and the bytes still leave.
 *
 * A prose promise in a README catches none of those. This module catches all
 * three, and `locality.test.ts` runs it against this package's own source tree
 * on every test run -- so the guarantee is checked by the suite rather than
 * asserted by a comment that nobody re-reads.
 *
 * ## What is checked, and what is honestly not
 *
 * Checked, statically, over source text:
 *
 * - every module specifier named by `import`/`export ... from`/`require`/
 *   dynamic `import()`, against a denylist of outbound-capable builtins and
 *   every known HTTP client package;
 * - every reference to a *global* egress capability (`fetch`, `WebSocket`,
 *   `XMLHttpRequest`, `EventSource`, `sendBeacon`, and the `http(s).request`
 *   families), in code positions only.
 *
 * Not checked, and stated rather than implied: what a dependency does at
 * runtime. Static analysis cannot follow `require` through a transitive
 * package, so `assertLocalPackage` additionally requires every declared
 * dependency to be a workspace package (or a relative path). Combined, the two
 * checks mean the only code that can run is code in this repository, which is
 * reviewable. That is a *stronger* claim than a denylist and an *honest* one --
 * but it holds only for as long as the test runs, which is why the test reads
 * `package.json` instead of trusting this comment.
 *
 * `node:http` is in the denylist even though the *gateway* legitimately uses it:
 * the gateway is a server, and a client request from a client is the thing that
 * breaks the claim. In this package there is no such distinction to make.
 */

/** Outbound-capable Node builtins. A server is a separate package (the gateway). */
export const FORBIDDEN_BUILTINS: readonly string[] = [
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:dns',
  'node:dns/promises',
  'cluster',
];

/** Outbound-capable npm packages, by name (scoped and bare forms). */
export const FORBIDDEN_PACKAGES: readonly string[] = [
  'undici',
  'axios',
  'node-fetch',
  'got',
  'superagent',
  'request',
  'request-promise',
  'needle',
  'ky',
  'wretch',
  'cross-fetch',
  'isomorphic-fetch',
  'ws',
  'socket.io-client',
  'graphql-request',
  '@grpc/grpc-js',
  'aws-sdk',
  '@aws-sdk/client-s3',
  'stripe',
  'twilio',
  'sentry-sdk',
  'datadog',
  'dd-trace',
  'openai',
  '@anthropic-ai/sdk',
  'google-genai',
  '@google/generative-ai',
];

/**
 * Global egress capabilities.
 *
 * Matched as identifiers in *code*, which is why the scanner strips comments and
 * string literals first. The reason is not elegance: this file's own denylist
 * contains these words as strings, and a scanner that could not tell a string
 * from a reference would have to exempt itself.
 *
 * These are the *capability* names -- the things that can move bytes. They are
 * checked wherever they appear, because none of them is a plausible English word
 * in a variable name.
 */
export const FORBIDDEN_GLOBALS: readonly string[] = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
];

/**
 * Global objects that can *reach* a capability, checked only in member position.
 *
 * `globalThis`, `window` and `self` are not capabilities: on their own they are
 * object references. In this package they are also ordinary nouns -- there is a
 * `const window = windowDaysFor(...)` in `retention.ts` -- and a check that
 * fires on a time window is a check somebody turns off. So the receiver is
 * reported only together with the member it reaches, which is also the only
 * form in which it is a finding at all.
 */
export const FORBIDDEN_RECEIVERS: readonly string[] = ['globalThis', 'window', 'self'];

/** Node's own global-ish spellings, checked for the same reason as the list above. */
const FORBIDDEN_MEMBERS: readonly string[] = [
  'http.request',
  'http.get',
  'https.request',
  'https.get',
  'net.connect',
  'net.createConnection',
  'net.Socket',
  'tls.connect',
  'dgram.createSocket',
];

export type LocalityViolationKind = 'import_specifier' | 'global_reference' | 'dependency';

export interface LocalityViolation {
  readonly kind: LocalityViolationKind;
  readonly name: string;
  readonly label: string;
  readonly line: number;
  readonly why: string;
}

export class LocalityViolationError extends Error {
  readonly violations: readonly LocalityViolation[];

  constructor(violations: readonly LocalityViolation[]) {
    super(
      `locality violated: ${violations
        .map((v) => `${v.label}:${v.line} ${v.name} (${v.kind})`)
        .join('; ')}`,
    );
    this.name = 'LocalityViolationError';
    this.violations = violations;
  }
}

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split('\n').length;

/**
 * Blanks comments while preserving every other offset and every newline, so a
 * finding still has a line number.
 *
 * This runs *before* the specifier extraction on purpose. A module specifier is
 * legitimately a string literal, so it cannot be stripped -- but a doc comment
 * that contains an example import must not be mistaken for one, and this file
 * has to be able to write about the thing it forbids.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < n && source.slice(i, i + 2) !== '*/') {
        if (source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      i += 2;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      // Copy the literal through untouched -- this pass only removes comments.
      const quote = ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        if (source[i] === '\n') break;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * `stripComments` plus blanking of string and template literal *contents*,
 * preserving offsets and line breaks. The braces of an interpolation are kept
 * (`${...}` is code), which is conservative in the right direction: a
 * `${fetch(...)}` is still found.
 */
export function stripCommentsAndStrings(source: string): string {
  const out = stripComments(source).split('');
  let i = 0;
  const n = out.length;
  while (i < n) {
    const ch = out[i];
    if (ch === undefined) break;
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out[i] = ' ';
      i += 1;
      while (i < n) {
        if (out[i] === '\\') {
          out[i] = ' ';
          if (i + 1 < n) out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (out[i] === quote) {
          out[i] = ' ';
          i += 1;
          break;
        }
        if (out[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Module specifiers, in source order. Extracted from the comment-stripped
 * source, because a specifier is legitimately a string literal (so it cannot be
 * blanked) while a doc comment that shows an example import must not count.
 */
const SPECIFIER_SITES: readonly RegExp[] = [
  /\bimport\s+(?:type\s+)?[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Computed access to a global: `globalThis['fetch'](url)`.
 *
 * The two passes above cannot see this one. `stripCommentsAndStrings` blanks the
 * string contents -- which is what keeps this file's own denylist from matching
 * itself -- and the name is *only* in the string. Leaving it there would mean
 * the check is defeated by one pair of square brackets, and an attacker (or a
 * frightened contributor) reads that as "the check does not work", which is
 * worse than not having it. So the pass runs on the comment-stripped source,
 * where string literals are still intact, and compares the *contents* of a
 * computed member against the same denylist.
 *
 * Dynamic assembly (`globalThis['fe' + 'tch']`) is still not seen. That is a
 * stated limit rather than an oversight: it is not a shape anyone writes by
 * accident, and the alternative -- parsing the whole language -- buys a false
 * sense of completeness. The test asserts the limit so it stays declared.
 */
const DYNAMIC_GLOBAL_SITES: readonly RegExp[] = [
  /\b(globalThis|window|self)\s*\[\s*['"`]([A-Za-z_$][A-Za-z0-9_$]*)['"`]\s*\]/g,
];

/** Package name from a specifier, so `@scope/pkg/sub` and `pkg/sub` agree. */
export function packageOfSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? specifier;
}

const isForbiddenSpecifier = (specifier: string): string | undefined => {
  if (FORBIDDEN_BUILTINS.includes(specifier)) return specifier;
  const pkg = packageOfSpecifier(specifier);
  if (FORBIDDEN_PACKAGES.includes(pkg)) return pkg;
  return undefined;
};

/**
 * Scan one source file. Pure and synchronous so it can run over a whole package
 * in a test with no fixtures and no I/O of its own.
 */
export function scanSource(source: string, label: string): readonly LocalityViolation[] {
  const violations: LocalityViolation[] = [];
  const noComments = stripComments(source);

  for (const site of SPECIFIER_SITES) {
    for (const match of noComments.matchAll(site)) {
      const specifier = match[1];
      const index = match.index;
      if (specifier === undefined || index === undefined) continue;
      const bad = isForbiddenSpecifier(specifier);
      if (bad === undefined) continue;
      violations.push({
        kind: 'import_specifier',
        name: bad,
        label,
        line: lineOf(source, index),
        why: 'a module that can open a socket makes the locality claim false',
      });
    }
  }

  const code = stripCommentsAndStrings(source);

  // A receiver in front of a capability: `globalThis.fetch`, `window.WebSocket`.
  // Collected first, and the member's own offset recorded, so the bare-token pass
  // below can skip the same `fetch` it would otherwise report a second time. Two
  // findings for one capability is not more thorough; it is a finding an operator
  // has to reconcile before believing the log.
  const memberOffsets = new Set<number>();
  for (const receiver of FORBIDDEN_RECEIVERS) {
    for (const member of FORBIDDEN_GLOBALS) {
      const re = new RegExp(
        `(?<![A-Za-z0-9_$.])${receiver}\\.${member}(?![A-Za-z0-9_$])`,
        'g',
      );
      for (const match of code.matchAll(re)) {
        const index = match.index;
        if (index === undefined) continue;
        memberOffsets.add(index + receiver.length + 1);
        violations.push({
          kind: 'global_reference',
          name: member,
          label,
          line: lineOf(source, index),
          why: 'a global egress capability is reachable through the global object, with no import to deny',
        });
      }
    }
  }

  for (const name of FORBIDDEN_GLOBALS) {
    // A whole-token match with no `.` exclusion, so `anything.fetch` is a finding
    // too. `prefetchCount` is still not a `fetch`: the trailing guard is what
    // keeps this from becoming noise, and noise is how a security check gets
    // deleted.
    for (const match of code.matchAll(wholeToken(name))) {
      const index = match.index;
      if (index === undefined || memberOffsets.has(index)) continue;
      violations.push({
        kind: 'global_reference',
        name,
        label,
        line: lineOf(source, index),
        why: 'a global egress capability is reachable without an import, so a denylist of imports is not enough',
      });
    }
  }

  for (const name of FORBIDDEN_MEMBERS) {
    // Dotted names, so `http.request` is the thing being looked for and
    // `logger.http.getCalls()` is not. The `.` guard on the left is needed here
    // for exactly that reason.
    const re = new RegExp(`(?<![A-Za-z0-9_$.])${name.replace(/\./g, '\\.')}(?![A-Za-z0-9_$])`, 'g');
    for (const match of code.matchAll(re)) {
      const index = match.index;
      if (index === undefined) continue;
      violations.push({
        kind: 'global_reference',
        name,
        label,
        line: lineOf(source, index),
        why: 'a global egress capability is reachable without an import, so a denylist of imports is not enough',
      });
    }
  }

  // Computed access, on the comment-stripped source so string contents survive.
  // Reported against the *member*, not the receiver, because the member is the
  // capability and the receiver is just how it was spelled.
  for (const site of DYNAMIC_GLOBAL_SITES) {
    for (const match of noComments.matchAll(site)) {
      const member = match[2];
      const index = match.index;
      if (member === undefined || index === undefined) continue;
      if (!FORBIDDEN_GLOBALS.includes(member)) continue;
      violations.push({
        kind: 'global_reference',
        name: member,
        label,
        line: lineOf(source, index),
        why: 'computed access to a global egress capability; the name is assembled at runtime to stay out of a plain import scan',
      });
    }
  }

  return violations;
}

const wholeToken = (name: string): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, 'g');

/** Throw if the source is not locality-clean. */
export function assertLocalSource(source: string, label: string): void {
  const violations = scanSource(source, label);
  if (violations.length > 0) throw new LocalityViolationError(violations);
}

/**
 * The one shape npm uses for "the sibling package with this name": an exact
 * three-part version with no range operator and no prerelease tag.
 *
 * Deliberately narrow. `1.0.0` is a workspace reference; `^6.0.0`, `~2.0`,
 * `1.0.0-beta` and `*` are registry ranges, and a check that accepts all of
 * them because they "start with a digit" accepts `axios@1.0.0-beta` as a
 * sibling package. The narrow form costs nothing here, because the one real
 * workspace dependency in this repository is pinned exactly.
 */
const WORKSPACE_EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * Every declared dependency must be a workspace package or a relative path.
 *
 * A registry dependency is a claim that its transitive closure is local, which
 * is not a claim this repository can review. This is the check that makes the
 * denylist above sufficient rather than merely helpful.
 *
 * A bare exact version is how npm workspaces spell "the sibling package with
 * this name", and it is not distinguishable from a registry pin by text alone --
 * so a caller that needs certainty must additionally confirm the installed
 * entry is a symlink into this repository. `locality.test.ts` does exactly that,
 * which is why the heuristic here is not the whole argument.
 */
export function assertLocalPackage(manifest: {
  readonly dependencies?: Record<string, string> | undefined;
  readonly devDependencies?: Record<string, string> | undefined;
  readonly peerDependencies?: Record<string, string> | undefined;
}): readonly LocalityViolation[] {
  const violations: LocalityViolation[] = [];
  const groups = [
    ['dependencies', manifest.dependencies],
    ['devDependencies', manifest.devDependencies],
    ['peerDependencies', manifest.peerDependencies],
  ] as const;
  for (const [group, deps] of groups) {
    for (const [name, range] of Object.entries(deps ?? {})) {
      const workspace =
        range.startsWith('workspace:') ||
        range.startsWith('file:') ||
        WORKSPACE_EXACT_VERSION.test(range);
      if (workspace) continue;
      violations.push({
        kind: 'dependency',
        name: `${name}@${range}`,
        label: group,
        line: 0,
        why: 'a dependency that is not a workspace package brings code that was never reviewed for locality',
      });
    }
  }
  return violations;
}

export interface LocalityReport {
  readonly root: string;
  readonly files: number;
  readonly violations: readonly LocalityViolation[];
}

/**
 * Scan a whole package directory. Used by the test against this package's own
 * `src/`, and available to any package that wants the same check on itself.
 */
export async function scanPackage(root: string, dir = join(root, 'src')): Promise<LocalityReport> {
  const violations: LocalityViolation[] = [];
  let files = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      files += 1;
      violations.push(...scanSource(await fs.readFile(full, 'utf8'), full));
    }
  };
  await walk(dir);
  return { root, files, violations };
}

/** The one-paragraph version, for `/strata about` and the README. */
export const LOCALITY_STATEMENT: string = [
  'strata-ctx has no network egress path.',
  'The artifact store, the gists and the telemetry are files on this machine.',
  '@strata-ctx/security imports no outbound-capable module and declares no',
  'registry dependency, and packages/security/test/locality.test.ts re-checks',
  'both facts against the source tree on every test run.',
].join(' ');
