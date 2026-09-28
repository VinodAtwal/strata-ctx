import { promises as fs } from 'node:fs';

import type { Gist, GistArtifact, PinDefect, StrataPolicy } from '@strata-ctx/core-types';
import { GistSchema, pinSetText, validateGist, verifyPinIntegrity } from '@strata-ctx/core-types';

import { parseArtifactUri } from './acl.js';
import type { RedactionOptions } from './redact.js';
import { RedactionEngine, redactDeep } from './redact.js';

/**
 * I-6: a gist is untrusted input.
 *
 * ## Why this module exists at all
 *
 * A gist is prose the *model* wrote about your code, and it is about to be
 * re-injected into the next turn as if it were a record of what happened. That
 * makes it the most powerful injection primitive in the product: a gist that
 * asserts a constraint is no longer in force is a governance change made by a
 * summariser, which is exactly the failure the pinned buffer exists to prevent
 * (architecture §7: "overwriting from the immutable buffer makes policy
 * injection structurally impossible").
 *
 * The distinction this module is built on:
 *
 * - **Mechanical checks are the boundary.** Byte-equality of the constraint set
 *   and ACL resolution of the artifact URIs are exact, both already exist (in
 *   core-types and ./acl.ts), and neither can be satisfied by clever text.
 * - **Heuristic checks are reporting.** "This field *looks* like it is claiming
 *   authority" is a signal for a human. It is reported and never enforced,
 *   because a heuristic that blocks legitimate work gets bypassed, and a
 *   bypassed heuristic that *is* load-bearing means the guarantee was never
 *   there in the first place.
 *
 * So the API is shaped to make the mechanical part impossible to skip: no
 * function here returns an untrusted gist. `defendGist` returns the *defended*
 * gist, with the pin set replaced from policy and unresolvable artifact refs
 * dropped, so a caller that forgets to check something still cannot escalate.
 *
 * ## The escalation shapes, and what stops each
 *
 * | attempt                                        | stopped by |
 * |------------------------------------------------|------------|
 * | gist adds a constraint the user never pinned     | byte-equality against `pinSetText(policy)` |
 * | gist drops or reorders a pinned constraint       | the same check, as `missing` / `reordered` defects |
 * | gist claims `governance.pinning = off`           | reported as an authority claim; the value stays data |
 * | gist's artifact URI reads outside the store      | the ACL, which is the only authority for a URI |
 * | gist's artifact URI carries a credential         | redaction before the gist is stored or re-injected |
 * | gist claims it edited the policy file            | `realpath` identity against the configured policy path |
 */

export type GistViolationKind =
  | 'schema_invalid'
  | 'invariant_failed'
  | 'constraint_missing'
  | 'constraint_extra'
  | 'constraint_reordered'
  | 'artifact_unresolvable'
  | 'policy_file_touched'
  | 'authority_claim'
  | 'secret_present';

export interface GistViolation {
  readonly kind: GistViolationKind;
  /** Dotted path into the gist, so a report points at a field a human can open. */
  readonly where: string;
  /**
   * A shape summary, never the offending text. A gist that leaks a credential
   * into `next.next_command` would otherwise be quoted in full by the very
   * report meant to flag it.
   */
  readonly detail: string;
}

export interface GistTrustOptions {
  readonly policy: StrataPolicy;
  /**
   * The ACL's authority, injected as a function so this module does not require
   * a store to be open. Return false for anything the ACL would refuse. When it
   * is absent, URIs are shape-checked only and the report says so, so a caller
   * that skipped the check cannot claim it passed.
   */
  readonly resolveArtifact?: (uri: string) => Promise<boolean> | boolean;
  /** Path of the policy file this process loaded, if any. Enables the identity check. */
  readonly policyPath?: string;
  readonly redaction?: Partial<RedactionOptions>;
}

export interface GistTrustReport {
  /**
   * True when no *enforcing* violation was found. An `authority_claim` does not
   * clear `ok` on its own -- the defended gist is still safe to use, and the
   * claim is a thing a human should look at.
   */
  readonly ok: boolean;
  readonly violations: readonly GistViolation[];
  readonly constraintDefects: readonly GistConstraintDefect[];
  /**
   * The gist with every untrusted field neutralised, or `undefined` when the
   * input was not a gist at all. `constraints` is always replaced wholesale from
   * policy, never merged.
   */
  readonly gist: Gist | undefined;
  /** True when redaction changed something in the returned gist. */
  readonly redacted: boolean;
  /** True when no `resolveArtifact` was supplied, so URIs were shape-checked only. */
  readonly artifactsUnverified: boolean;
}

export class GistTrustError extends Error {
  readonly violations: readonly GistViolation[];

  constructor(violations: readonly GistViolation[]) {
    super(`gist refused: ${violations.map((v) => `${v.kind}@${v.where}`).join(', ')}`);
    this.name = 'GistTrustError';
    this.violations = violations;
  }
}

/**
 * Text that *claims* authority, in a model-authored field.
 *
 * Reported, never enforced -- see the module header. Kept tight on purpose: a
 * pattern list that flags ordinary prose ("the pin buffer enforces the policy")
 * is a pattern list that gets switched off, and a switched-off warning is worse
 * than no warning because the operator believes they are covered.
 */
const AUTHORITY_CLAIMS: readonly { readonly re: RegExp; readonly why: string }[] = [
  {
    re: /^\s*\[?\s*(?:system|admin|root|developer|strata|governance|policy)\s*\]?\s*[:>-]/i,
    why: 'a role prefix reads as an authority the model does not have',
  },
  {
    re: /\bconstraints?\s*[:=]\s*\[/i,
    why: 'declares the pin set, which is a verification target and not a writable field',
  },
  {
    re: /\bpinning\s*[:=]\s*['"`]?off\b/i,
    why: 'a summary that switches the pinning mode off is a privilege change',
  },
  {
    re: /\bgovernance\s*\.\s*pinning\b/i,
    why: 'addresses policy configuration from model output',
  },
  {
    re: /\bignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+instructions\b/i,
    why: 'the canonical instruction-override string',
  },
  {
    re: /\bpolicy\s+has\s+been\s+(?:updated|changed|removed)\b/i,
    why: 'asserts a policy change that only a human may make',
  },
  {
    // "the user said to do this" is the claim a summariser is most likely to
    // make, and the one a reader is most likely to believe, because it is
    // attributing the instruction to a human. It is deliberately narrow: only
    // attribution verbs match, so ordinary prose about the user does not fire.
    re: /\b(?:the\s+)?user\s+(?:said|says|told\s+(?:me|us|you)|asked\s+(?:me|us)\s+to|requested|instructed|confirmed)\b/i,
    why: 'attributes an instruction to the user, which a summary may not do on the user\'s behalf',
  },
];

interface Field {
  readonly path: string;
  readonly value: string;
}

/** Every model-authored string leaf. Deterministic fields are included too, cheaply. */
const narrativeOf = (gist: Gist): readonly Field[] => [
  { path: 'goal', value: gist.goal },
  ...gist.changed.flatMap((c, i) => [
    { path: `changed[${i}].what`, value: c.what },
    { path: `changed[${i}].why`, value: c.why },
  ]),
  ...gist.decided.flatMap((d, i) => [
    { path: `decided[${i}].choice`, value: d.choice },
    { path: `decided[${i}].why`, value: d.why },
    ...d.alternatives_rejected.map((a, j) => ({
      path: `decided[${i}].alternatives_rejected[${j}]`,
      value: a,
    })),
  ]),
  ...gist.unresolved.map((u, i) => ({ path: `unresolved[${i}]`, value: u })),
  { path: 'next.question', value: gist.next.question },
  { path: 'next.next_command', value: gist.next.next_command },
  ...gist.next.blockers.map((b, i) => ({ path: `next.blockers[${i}]`, value: b })),
  ...gist.log_gist.ran.map((v, i) => ({ path: `log_gist.ran[${i}]`, value: v })),
  ...gist.log_gist.failed.map((v, i) => ({ path: `log_gist.failed[${i}]`, value: v })),
  ...gist.log_gist.salient_errors.map((v, i) => ({
    path: `log_gist.salient_errors[${i}]`,
    value: v,
  })),
  ...gist.log_gist.salient_warnings.map((v, i) => ({
    path: `log_gist.salient_warnings[${i}]`,
    value: v,
  })),
  { path: 'log_gist.raw_uri', value: gist.log_gist.raw_uri },
  ...Object.entries(gist.current_values).map(([k, v]) => ({
    path: `current_values.${k}`,
    value: v,
  })),
];

/** Every URI a gist asserts, tagged with the field it came from. */
export const gistArtifactUris = (gist: Gist): readonly Field[] => [
  ...gist.artifacts.map((a, i) => ({ path: `artifacts[${i}].uri`, value: a.uri })),
  { path: 'log_gist.raw_uri', value: gist.log_gist.raw_uri },
];

const sameFile = async (a: string, b: string): Promise<boolean> => {
  try {
    const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return ra === rb;
  } catch {
    // A path that does not exist cannot be the file that was loaded, and a
    // `changed[].path` naming a file that does not exist is not a policy edit.
    return false;
  }
};

/** One byte-equality defect, as core-types reports it. */
export interface GistConstraintDefect {
  readonly kind: PinDefect;
  readonly text: string;
}

const DEFECT_KIND: Readonly<Record<PinDefect, GistViolationKind>> = {
  missing: 'constraint_missing',
  extra: 'constraint_extra',
  reordered: 'constraint_reordered',
};

export async function defendGist(
  input: unknown,
  options: GistTrustOptions,
): Promise<GistTrustReport> {
  const violations: GistViolation[] = [];
  const artifactsUnverified = options.resolveArtifact === undefined;

  const parsed = GistSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((issue) => ({
        kind: 'schema_invalid' as const,
        where: issue.path.join('.') || '(root)',
        detail: `${issue.code}: ${issue.message}`,
      })),
      constraintDefects: [],
      gist: undefined,
      redacted: false,
      artifactsUnverified,
    };
  }
  const gist: Gist = parsed.data;

  // Steps 4b and 4c of the compaction transaction, reused rather than
  // reimplemented: `validateGist` owns the structural invariants and
  // `verifyPinIntegrity` owns the byte-equality gate. Both are already the
  // product's security core; a second implementation would be a second thing to
  // get wrong.
  for (const defect of validateGist(input).defects) {
    violations.push({ kind: 'invariant_failed', where: 'gist', detail: defect.kind });
  }

  const integrity = verifyPinIntegrity(pinSetText(options.policy), gist.constraints);
  for (const defect of integrity.defects) {
    violations.push({
      kind: DEFECT_KIND[defect.kind],
      where: 'constraints',
      // The defect text is policy text, which is safe to quote, and quoting it is
      // the difference between a report a user can act on and one they must take
      // on trust.
      detail: `${defect.kind}: ${JSON.stringify(defect.text)}`,
    });
  }

  // Artifact URIs: the ACL decides, and a refusal is named rather than guessed.
  const survivingArtifacts: GistArtifact[] = [];
  for (const [i, artifact] of gist.artifacts.entries()) {
    violations.push(...(await checkUri(artifact.uri, `artifacts[${i}].uri`, options, artifactsUnverified)));
    if (!violations.some((v) => v.kind === 'artifact_unresolvable' && v.where === `artifacts[${i}].uri`)) {
      survivingArtifacts.push(artifact);
    }
  }
  violations.push(
    ...(await checkUri(gist.log_gist.raw_uri, 'log_gist.raw_uri', options, artifactsUnverified)),
  );

  // A summary that claims to have edited the policy file is a claim about the
  // one file that decides what is allowed. `realpath` identity, not string
  // equality: `./config/policy.yaml` and `config/../config/policy.yaml` are the
  // same file, and only the resolved path says so.
  if (options.policyPath !== undefined) {
    for (const [i, changed] of gist.changed.entries()) {
      if (await sameFile(changed.path, options.policyPath)) {
        violations.push({
          kind: 'policy_file_touched',
          where: `changed[${i}].path`,
          detail: 'a gist may not claim to have changed the loaded policy file',
        });
      }
    }
  }

  for (const field of narrativeOf(gist)) {
    const claim = AUTHORITY_CLAIMS.find((c) => c.re.test(field.value));
    if (claim !== undefined) {
      violations.push({ kind: 'authority_claim', where: field.path, detail: claim.why });
    }
  }

  // I-3 for gists: a gist is written to the store *and* re-injected into the
  // next request, so a secret inside one is a secret in both places.
  const engine = new RedactionEngine({ mode: 'placeholder', ...options.redaction });
  const redacted = redactDeep(gist, { mode: 'placeholder', ...options.redaction });
  const uris = [...gist.artifacts.map((a) => a.uri), gist.log_gist.raw_uri];
  if (uris.some((uri) => engine.containsSecret(uri))) {
    violations.push({
      kind: 'secret_present',
      where: 'artifacts[].uri',
      detail: 'an artifact uri or raw_uri carries a credential shape',
    });
  }

  // The one field the model does not get to write, replaced rather than merged.
  // Merge is what architecture §7 rules out: a merged list is a superset, and a
  // superset of the pin set is a policy change nobody approved.
  const defended: Gist = {
    ...redacted,
    constraints: [...pinSetText(options.policy)],
    artifacts: survivingArtifacts,
  };

  return {
    ok: violations.every((v) => v.kind === 'authority_claim'),
    violations,
    constraintDefects: integrity.defects,
    gist: defended,
    redacted: JSON.stringify(redacted) !== JSON.stringify(gist),
    artifactsUnverified,
  };
}

async function checkUri(
  uri: string,
  where: string,
  options: GistTrustOptions,
  shapeOnly: boolean,
): Promise<GistViolation[]> {
  try {
    parseArtifactUri(uri);
  } catch (e) {
    // The parse error's own name is the useful part: `traversal_segment` says
    // this was an escape attempt, `not_found` would say a pointer is gone.
    return [{ kind: 'artifact_unresolvable', where, detail: e instanceof Error ? e.message : 'unparseable' }];
  }
  if (shapeOnly) {
    return [
      {
        kind: 'artifact_unresolvable',
        where,
        detail: 'no resolver was supplied: the uri is well-formed but its existence is unverified',
      },
    ];
  }
  const resolve = options.resolveArtifact;
  if (resolve === undefined) return [];
  const authorised = await resolve(uri);
  return authorised
    ? []
    : [{ kind: 'artifact_unresolvable', where, detail: 'the ACL refused it' }];
}

/** The throw-shaped form, for the compaction transaction's step-4 gate. */
export async function assertGistTrustworthy(
  input: unknown,
  options: GistTrustOptions,
): Promise<Gist> {
  const report = await defendGist(input, options);
  if (!report.ok || report.gist === undefined) throw new GistTrustError(report.violations);
  return report.gist;
}
