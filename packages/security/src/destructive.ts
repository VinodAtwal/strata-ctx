import { z } from 'zod';

/**
 * I-9: the deterministic half of tool-argument enforcement.
 *
 * ## What this is for, and what it is not
 *
 * `handlePreToolUse` pins constraints, re-applies them, and reports drift. It
 * never looked at what the tool was *about to do*. A live session on 2026-10-01
 * asked a local model to `rm -rf` a directory holding a canary file: the pin was
 * sent, `pin_missing_pre_apply` was false, the telemetry was clean -- and the
 * directory survived only because a 3B model happened to decline. Nothing in the
 * request path would have stopped it. A constraint system that cannot say no to
 * anything is a logging system, so this is the floor that makes the word
 * "enforced" mean something a reader would believe.
 *
 * ## Deliberately enumerated, and blind to intent
 *
 * These are hand-written patterns, not a classifier. That is a real limit and the
 * reason the honest claim is "a hard floor", not "policy enforcement":
 *
 * - `rm -rf /data` is caught. `mv /data /dev/null` is not, and neither is
 *   `find . -delete`, because those are different strings and the only way to
 *   know they mean the same thing is to understand them.
 * - A command assembled from variables at runtime (`R=$PWD; rm -rf $R`) evades
 *   every entry here. An attacker who wanted to defeat this would succeed, and
 *   the design bets that most agents are not attackers -- the threat is a
 *   confused agent acting destructively, not a targeted one.
 *
 * A model judge would close the intent gap and cost a model call per tool call,
 * which fights the product's own economics. So judging is a later, opt-in arm,
 * and this is the part that ships first and never spends anything.
 *
 * ## Fail open, always
 *
 * Every function here returns a verdict and throws nothing. A detector that
 * throws on a malformed argument would turn an unknown shape into a failed tool
 * call, and refusing work the user asked for is the worse failure. An unparseable
 * tool call is `allow` with a note, never `block`.
 */

export const DestructiveRuleId = z.enum([
  'recursive_force_delete',
  'force_push',
  'history_rewrite',
  'database_drop',
  'table_truncate',
  'filesystem_format',
  'privilege_escalation',
  'credential_write',
  'bulk_permission_change',
  'service_disable',
]);
export type DestructiveRuleId = z.infer<typeof DestructiveRuleId>;

export type DestructiveVerdict = 'deny' | 'allow';

export interface DestructiveRule {
  readonly id: DestructiveRuleId;
  /** What the rule blocks, in a form a person can review in a config. */
  readonly description: string;
  /**
   * The shape that fires the rule. Must carry the `g` flag. Shared instances are
   * safe: callers use `matchAll`.
   */
  readonly regex: RegExp;
  /**
   * Narrows a match to the command it actually came from. `rm` inside
   * `echo "do not rm -rf /"` is documentation, not an instruction, and a rule that
   * cannot tell those apart gets disabled after its first false positive. The
   * returned span is the value to report, so a rule can point at the token rather
   * than the whole line.
   */
  readonly resolve: (match: RegExpMatchArray, segment: string) => DestructiveVerdict;
}

/** Shell operators that would let a benign-looking command run a denied one. */
const CHAIN = String.raw`(?:\s*(?:&&|\|\||;|\||\n)\s*|\s*\$\(\s*|\s*\|\s*)`;

/**
 * Split a command line into segments on shell chaining.
 *
 * Needed because `echo hi && rm -rf /` is one string and two intents, and a rule
 * that scans whole lines either misses the tail or fires on the head. Splitting
 * on operators and ignoring anything inside quotes is an approximation: quoting
 * is not fully modelled here, so a segment boundary inside a quoted string is a
 * false split, which can only ever produce an extra `allow` segment.
 */
export const commandSegments = (command: string): readonly string[] =>
  command
    .split(new RegExp(`${CHAIN}`, 'g'))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * True when the segment *invokes* one of `names`, as opposed to mentioning it.
 *
 * `echo "never run rm -rf /"` mentions it; `rm -rf /` invokes it. Splitting on the
 * segment's first token is enough to tell those apart for the single-word tools
 * this file covers, and an absolute path (`/bin/rm`) is reduced to its basename
 * first. It is exported for the test that pins this behaviour rather than
 * asserting it inline, because the whole false-positive story rests on it.
 */
export const invokes = (segment: string, ...names: readonly string[]): boolean => {
  const first = segment.split(/\s+/)[0] ?? '';
  const base = first.split('/').pop() ?? first;
  return names.includes(base);
};

const deny = (): DestructiveVerdict => 'deny';

/**
 * The default resolver for a rule whose tool must appear in command position.
 *
 * Every rule in this catalogue anchors on a tool name -- `rm`, `git`, `dd` -- and a
 * bare `rm` matches `echo "do not rm -rf /data"` just as happily as it matches
 * the command itself. A detector that fires on a warning about the thing it
 * detects is a detector an operator turns off, so the rule demands that the
 * segment actually invokes that tool. This is what makes chaining work: after
 * `commandSegments` splits on `&&`, each segment is judged on its own first word.
 */
const denyIfInvoked =
  (...names: readonly string[]) =>
  (_match: RegExpMatchArray, segment: string): DestructiveVerdict =>
    invokes(segment, ...names) ? 'deny' : 'allow';

/**
 * `sudo`, `doas`, `su`, and `chmod u+s` / `chmod 4755` -- escalation is the step
 * that turns a recoverable mistake into an unrecoverable one.
 */
const PRIVILEGE_ESCALATION: DestructiveRule = {
  id: 'privilege_escalation',
  description: 'run a command with elevated privileges',
  regex: /(?:^|[\s;&|`(])(?:sudo|doas|pkexec)\b/g,
  resolve: () => deny(),
};

/**
 * Setuid bit. Separate from `PRIVILEGE_ESCALATION` because it is a file mode
 * rather than a command, and an agent that chmods a binary is escalating without
 * naming any of the three tools above.
 */
const SETUID: DestructiveRule = {
  id: 'privilege_escalation',
  description: 'set the setuid or setgid bit on a file',
  // Two forms: the symbolic `u+s` and the octal `4755`. The earlier pattern
  // demanded a word boundary immediately after the `s`, which a path defeats --
  // `chmod u+s /tmp/x` is `u+s` then a space, and the boundary test consumed the
  // space instead of matching the mode. The trailing lookahead is what makes the
  // mode a mode: `chmod u+s` has to be followed by something, not end the line.
  regex:
    /\bchmod\b(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+(?:[ugoa]*[-+=][rwxXst]*[st][rwxXst]*|[2467][0-7]{3})\b/g,
  resolve: denyIfInvoked('chmod'),
};

export const DESTRUCTIVE_RULES: readonly DestructiveRule[] = Object.freeze([
  {
    id: 'recursive_force_delete',
    description: 'recursively force-delete a path',
    regex: /\brm\b[^\n]*?(?:\s-[a-zA-Z]*[rR][a-zA-Z]*f|\s-[a-zA-Z]*f[a-zA-Z]*[rR]|\s--recursive\b[^\n]*--force|\s--force\b[^\n]*--recursive)/g,
    resolve: denyIfInvoked('rm'),
  },
  {
    id: 'recursive_force_delete',
    description: 'recursively force-delete a path',
    // One rule for every spelling that means the same thing. `rm -rf /`, `rm -fr /`,
    // `rm -r -f /`, `rm -f -r /`, `rm -r --force /` and `rm --recursive --force /`
    // are all the same decision, so instead of enumerating them this matches a run
    // of flags that contains *both* a recursive flag and a force flag in any order.
    // The separated-short-flag case is why the first alternative is a lookahead pair
    // rather than a single `-[a-z]*` class.
    regex:
      /\brm\b(?=[^\n]*?(?:^|\s)-{1,2}(?:r\b|recursive\b))(?=[^\n]*?(?:^|\s)-{1,2}(?:f\b|force\b))|\brm\b\s+-{1,2}[A-Za-z]*(?:rf|fr)[A-Za-z]*\b/g,
    resolve: denyIfInvoked('rm'),
  },
  {
    id: 'recursive_force_delete',
    description: 'delete every entry in a directory root or by glob',
    // `rm /*` and `rm -rf /*` have no space between the flag and the target, which
    // is what a shell-glob habit produces. Held until the previous rule reports
    // first for the *same* decision: two rules describing one refusal produced
    // "recursively force-delete a path; recursively force-delete a path" in the
    // user's face, with a duplicated id. One refusal, one line.
    regex: /\brm\b\s+(?:-[A-Za-z]+\s*)*\/(?:\s|\*|$)|\brm\b\s+\/(?:\s|$)/g,
    resolve: denyIfInvoked('rm'),
  },
  {
    id: 'filesystem_format',
    description: 'format or overwrite a block device',
    regex: /\b(?:mkfs(?:\.\w+)?|fdisk|parted|dd)\b[^\n]*?\/dev\//g,
    resolve: denyIfInvoked('mkfs', 'mkfs.ext4', 'mkfs.xfs', 'fdisk', 'parted', 'dd'),
  },
  {
    id: 'filesystem_format',
    description: 'write zeros over a block device',
    regex: /\bdd\b[^\n]*?\bof=\/dev\//g,
    resolve: denyIfInvoked('dd'),
  },
  {
    id: 'force_push',
    description: 'force-push, discarding remote history',
    regex: /\bgit\b[^\n]*?\bpush\b[^\n]*?(?:--force\b(?!-with-lease)|\s-f\b)/g,
    resolve: denyIfInvoked('git'),
  },
  {
    id: 'history_rewrite',
    description: 'rewrite or discard git history',
    regex: /\bgit\b[^\n]*?\b(?:reset\s+--hard\b|filter-branch\b|reflog\s+expire\b|checkout\s+--orphan\b)/g,
    resolve: denyIfInvoked('git'),
  },
  {
    id: 'service_disable',
    description: 'stop or disable a system service',
    regex: /\b(?:systemctl|service)\b[^\n]*?\b(?:stop|disable|mask)\b/g,
    resolve: denyIfInvoked('systemctl', 'service'),
  },
  {
    id: 'service_disable',
    description: 'kill every process matching a name',
    regex: /\b(?:pkill|killall)\b/g,
    resolve: denyIfInvoked('pkill', 'killall'),
  },
  {
    id: 'database_drop',
    description: 'drop a database, table, or schema',
    regex: /\b(?:drop|truncate)\s+(?:database|schema|table)\b/gi,
    // No command-position check, on purpose. `truncate table users` almost never
    // arrives as a bare shell command; it arrives inside a `psql -c '...'` string,
    // where the first token is `psql` and a positional test would wave it through.
    // The cost is that a log line or a comment mentioning `DROP TABLE` also fires,
    // so the finding carries the matched text and the segment for review.
    resolve: () => deny(),
  },
  {
    id: 'table_truncate',
    description: 'delete every row from a table',
    regex: /\btruncate\s+table\b/gi,
    resolve: () => deny(),
  },
  {
    id: 'bulk_permission_change',
    description: 'open permissions recursively on a path tree',
    regex: /\bchmod\b[^\n]*?(?:\s-R\b|\s777\b|\s-777\b)/g,
    resolve: denyIfInvoked('chmod'),
  },
  {
    id: 'bulk_permission_change',
    description: 'grant ownership recursively',
    regex: /\bchown\b[^\n]*?\s-R\b/g,
    resolve: denyIfInvoked('chown'),
  },
  {
    id: 'credential_write',
    description: 'write to a shell profile or an ssh authorized_keys file',
    regex: /(?:^|[\s;&|])(?:>|>>|tee\s+-a|echo[^|]*>)\s*(?:[^\s]*\/)?(?:\.bashrc|\.zshrc|\.profile|authorized_keys)\b/g,
    resolve: () => deny(),
  },
  SETUID,
  PRIVILEGE_ESCALATION,
]);

export interface DestructiveFinding {
  readonly id: DestructiveRuleId;
  readonly description: string;
  /** The exact text that tripped the rule, for a message the user can act on. */
  readonly evidence: string;
  /** The segment the match came from, so an approval can be about one command. */
  readonly segment: string;
}

export interface DestructiveScan {
  readonly verdict: DestructiveVerdict;
  readonly findings: readonly DestructiveFinding[];
  /**
   * Set when a tool call carried no recognisable command. The caller still allows
   * it; the field exists so a caller that wants to be strict about coverage can
   * count the cases this module did not reason about.
   */
  readonly unrecognised: boolean;
}

export interface ScanTarget {
  /** The tool name as the host reports it. */
  readonly tool: string;
  /** The tool's arguments, untyped: hosts disagree about the shape. */
  readonly parameters: Readonly<Record<string, unknown>> | undefined;
}

/** Argument keys that carry a shell command across the hosts we support. */
const COMMAND_KEYS = ['command', 'cmd', 'run', 'script', 'shell_command', 'input'] as const;

/** Argument keys that carry a filesystem path, for the path-shaped rules. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'destination', 'uri'] as const;

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Pull every candidate command and path out of a tool call.
 *
 * Hosts disagree on both the tool name and the argument shape -- OpenCode sends
 * `bash` with `command`, Claude sends `Bash` with `command`, and a write tool
 * sends `file_path` with no command at all. Enumerating the known keys and
 * ignoring everything else is what keeps this deterministic: an unknown key is a
 * string this function does not return, so it cannot be scanned, and
 * `unrecognised` reports that rather than pretending coverage.
 */
export const extractTargets = (target: ScanTarget): readonly { command: string }[] => {
  // `params` is whatever the host sent, and a host can send anything. The cast
  // narrows it for the compiler; the check is what makes it safe at runtime, and
  // it is here rather than in `scanDestructive` because a caller may reach
  // `extractTargets` directly.
  const params: unknown = target.parameters;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return [];
  const bag = params as Readonly<Record<string, unknown>>;
  const out: { command: string }[] = [];
  for (const key of COMMAND_KEYS) {
    const value = asString(bag[key]);
    if (value !== undefined && value.length > 0) out.push({ command: value });
  }
  for (const key of PATH_KEYS) {
    const value = asString(bag[key]);
    // A bare path is scanned as a one-token command so path-shaped rules still
    // see it; `commandSegments` leaves it intact.
    if (value !== undefined && value.length > 0) out.push({ command: value });
  }
  return out;
};

/**
 * The check. Pure, allocation-light, and never throws.
 *
 * Ordering matters for the report: findings are returned in catalogue order so a
 * user who trips two rules sees the first one the code checks, which keeps the
 * message stable across versions instead of depending on regex iteration.
 */
export const scanDestructive = (target: ScanTarget): DestructiveScan => {
  const targets = extractTargets(target);
  if (targets.length === 0) return { verdict: 'allow', findings: [], unrecognised: true };
  const findings: DestructiveFinding[] = [];
  for (const { command } of targets) {
    for (const segment of commandSegments(command)) {
      // A segment that merely *names* a denied command is documentation. The
      // cheapest honest test: the dangerous token has to be in command position,
      // which `invokes` checks against the first word of the segment.
      for (const rule of DESTRUCTIVE_RULES) {
        rule.regex.lastIndex = 0;
        for (const match of segment.matchAll(rule.regex)) {
          if (rule.resolve(match, segment) !== 'deny') continue;
          // One finding per rule, first match wins. Several entries can describe
          // the same refusal (`rm -rf /data` trips both the flag rule and the
          // root-glob rule), and a user told the same thing twice reads a bug.
          if (findings.some((f) => f.id === rule.id)) continue;
          findings.push({
            id: rule.id,
            description: rule.description,
            evidence: match[0].trim().slice(0, 120),
            segment: segment.slice(0, 200),
          });
          break;
        }
      }
    }
  }
  return {
    verdict: findings.length > 0 ? 'deny' : 'allow',
    findings,
    unrecognised: false,
  };
};

/**
 * Structural self-check, called by the tests and by the constructor.
 *
 * A catalogue with a missing `g` flag silently reports the first match per string
 * and nothing else, which is a detector that works in the demo and misses in
 * production -- the exact failure the pattern catalogue in `patterns.ts` guards
 * against, and the same guard for the same reason.
 */
export function assertDestructiveRulesWellFormed(rules: readonly DestructiveRule[] = DESTRUCTIVE_RULES): void {
  for (const rule of rules) {
    if (!rule.regex.flags.includes('g')) {
      throw new Error(`destructive rule ${rule.id} must carry the g flag`);
    }
    if (typeof rule.resolve !== 'function') {
      throw new Error(`destructive rule ${rule.id} must have a resolve function`);
    }
    if (rule.description.length === 0) {
      throw new Error(`destructive rule ${rule.id} must describe itself`);
    }
  }
}
