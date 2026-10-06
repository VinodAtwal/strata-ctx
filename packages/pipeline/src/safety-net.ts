import type { NonGovernanceTier, Tier } from '@strata-ctx/core-types';

import type { TierRetention } from './triage.js';

/**
 * P0-3 (docs/risk-analysis.md §5.1): fail closed on classification uncertainty,
 * plus a conservative declarative-constraint override that may only *promote* a
 * tier toward `verbatim`, never demote, and a count so the override's
 * intervention rate is observable.
 *
 * ## The premise correction, because the risk doc's version of it is wrong
 *
 * R2 says "when `classifyBlockText` is not confident, the tier must be
 * `verbatim`, not `episodic`". `classifyBlockText` (./severity.ts:180) classifies
 * *log severity* -- ERROR/FATAL, for F7 -- and returns `Severity | undefined`.
 * It has no opinion about tiers. Triage (./triage.ts) does not classify text
 * either: it re-checks a tier that the ingress adapter already declared, and the
 * adapters decide from the *kind* of text (system -> `user_intent`, message text
 * -> `episodic`, tool traffic -> `tool_state`), not from its wording.
 *
 * So the classifier that "must fail closed" does not exist yet, and this module
 * is the first thing in the tree that reads a block's wording for a *retention*
 * decision. The chain R2 is protecting is real regardless: ingress puts a
 * fact-shaped constraint in `episodic`, `episodic` is `compact`, the gist drops
 * it, and the agent violates a rule it was obeying one turn earlier. What changes
 * is where the fix belongs -- not "make an existing classifier more careful",
 * but "add a classifier, and constrain it so it can only ever err toward
 * keeping the text".
 *
 * ## Why the target is declarative phrasing
 *
 * The measured gap (R2): LLM compactors hold 1.00 recall on imperative,
 * conditional and passive constraint phrasing and lose **38--48 absolute
 * points on declarative phrasing** -- "the patient is allergic to penicillin"
 * is recognised as a constraint 62% of the time by one model, 52% by a
 * cascade, **0% by regex**. A regex cannot save this and a well-meaning prompt
 * cannot either, because the constraint is stated as a *fact* rather than a
 * command. So the detector is built as two independent signals rather than one
 * pattern:
 *
 * - a safety-relevant subject (a hazard lexicon: medical, physical,
 *   security/data) *plus* an assertion frame (`is/has/denies/...`) is a
 *   **constraint** -- the paper's shape, confident;
 * - a safety-relevant subject with no assertion frame is **uncertain** -- the
 *   text is about something that must not be lost but does not parse as a
 *   sentence ("Allergies: penicillin"), and uncertainty is exactly the case
 *   that fails *closed*;
 * - an obligation or prohibition marker (`never` at a clause boundary, `must`,
 *   `forbidden`, ...) is a **constraint** regardless of subject, because
 *   ingress never looked at the wording at all and an imperative rule sitting
 *   in `episodic` is lost by the same route.
 *
 * Bare `must` is deliberately a marker even though epistemic uses exist ("it
 * must be a race"). A false promotion costs tokens; a missed obligation costs
 * the rule, which is the trade R2 asks for. `never`/`do not` are *not*
 * free-floating markers for the same reason in reverse: "so it never throws"
 * appears in ordinary task descriptions, so they are anchored to a clause
 * boundary.
 *
 * ## The override may only promote, and that is structural
 *
 * `promoteTier` refuses unless `strictness(retention[wanted])` is strictly
 * greater than `strictness(retention[current])`, and refuses `artifact_ref`
 * outright. A future edit that hands it a weaker target cannot demote anything,
 * because the comparison rejects equality and every weakening. Nothing in here
 * writes a tier that the policy does not already treat as *more* protected.
 *
 * `artifact_ref` is excluded on its own terms rather than by the rank: the
 * bytes of an artifact pointer are not in the block, they are in the artifact
 * store, so there is nothing here for compaction to lose and promoting the stub
 * would spend `user_intent` capacity on a pointer.
 *
 * ## The forced conflation, which is a finding rather than a design choice
 *
 * The promotion target is `user_intent`, because `Tier` is a frozen union in
 * core-types and `verbatim` has exactly two members: `governance`
 * (unrepresentable on a `NonGovernanceBlock`) and `user_intent`. A constraint
 * about a patient is therefore recorded as if it were the task. That is wrong
 * in the way spec.md principle 4 is about -- conflating one kind of knowledge
 * with another -- and the honest fix is a distinct tier (or a `verbatim`
 * retention flag) once `core-types/src/context.ts` can be unfrozen. The
 * conflation is recorded here so the next person does not mistake it for an
 * intention.
 *
 * ## Observable, and pure
 *
 * The count rides on `TriageReport` rather than on a telemetry event type:
 * `STRATA_EVENT_TYPES` lives in the frozen core-types contract, so adding an
 * event would be a contract change for a number that belongs to one stage. A
 * check that never fires and one that fires on everything are indistinguishable
 * without `promotedToVerbatim`.
 *
 * Determinism (N6): the verdict is a pure function of the block's text. Same
 * text, same verdict, on every run.
 */

/**
 * What the detector decided about a block's text.
 *
 * `ordinary` is the only verdict that leaves a tier alone. Both `uncertain` and
 * `constraint` promote, which is what "fail closed" means here: the cost of a
 * wrong promotion is a few thousand bytes that survive longer than they needed
 * to, and the cost of a wrong demotion is a rule the agent no longer obeys.
 */
export type RetentionVerdict = 'ordinary' | 'uncertain' | 'constraint';

export interface RetentionClassification {
  readonly verdict: RetentionVerdict;
  /**
   * Whether the detector has a definite answer. `confident: false` is the
   * fail-closed trigger itself: the text is about something a compactor must
   * not destroy, and the detector cannot say why in one clause.
   */
  readonly confident: boolean;
}

/** What `promoteTier` did. `tier` is the tier the block should carry. */
export interface TierPromotion {
  /** Always `user_intent` today; typed `NonGovernanceTier` because a promotion can never *produce* governance. */
  readonly tier: NonGovernanceTier;
  /** The verdict that caused the promotion; always `uncertain` or `constraint`. */
  readonly verdict: RetentionVerdict;
}

/**
 * Safety-relevant subjects. The lexicon is what separates "a constraint a
 * compactor must not lose" from "any sentence", and it is deliberately narrow:
 * a declarative sentence about anything outside these domains stays `episodic`,
 * which is what keeps the intervention rate low enough to be readable in the
 * report.
 */
const HAZARD: readonly RegExp[] = [
  // Medical / physiological facts about a person. The Compaction Cliff's own
  // worked example is "the patient is allergic to penicillin".
  /\bpenicillin\b/i,
  /\ballerg(?:y|ies|ic|ens)\b/i,
  /\banaphyla(?:x[ie]s|ctic)\b/i,
  /\bcontraindicat\w*\b/i,
  /\bepinephrine\b/i,
  // Physical hazards: the words a warning sign uses, not the words a build log
  // uses (so no `fatal`, which is a severity and belongs to ./severity.ts).
  /\b(?:radioactiv\w+|carcinogen\w*|asbestos|flammable|explosive|corrosive)\b/i,
  /\b(?:toxic\w*|poison\w*|lethal|caustic)\b/i,
  /\bhigh[- ]voltage\b/i,
  // Security / data-handling facts. These are constraints about information
  // rather than about people, and they are the ones a summary paraphrases away
  // first ("the key" instead of the key).
  /\b(?:credentials?|passphrases?|private keys?|api keys?|secrets?)\b/i,
  /\bcustomer data\b/i,
  /\bpersonally identifiable\b/i,
];

/**
 * An assertion frame: `is/are/has/denies`-style, the shape the literature
 * identifies as first-person-fact construction. Matched only against a hazard
 * subject -- on its own it is every sentence in the corpus, which is why it is
 * never a signal by itself.
 */
const ASSERTION =
  /\b(?:is|are|was|were|has|have|had|denies|denied|deny|contains?|causes?|triggers?|cannot|can't)\b/i;

/**
 * Obligation and prohibition markers.
 *
 * Clause-start anchors are load-bearing: "refactor the estimator so it never
 * throws" is a task description, and a detector that promotes it hands every
 * ordinary request the verbatim tier. `\bmust\b` is not anchored, because
 * "every ticket must carry the command that reproduces the problem" carries
 * its obligation mid-clause, and the epistemic false positives that costs are
 * the accepted trade above.
 */
const DIRECTIVE: readonly RegExp[] = [
  /(?:^|[.;,:\n]\s*)(?:you\s+)?(?:never|do\s+not|don't)\b/i,
  /\b(?:must|shall)\b/i,
  /\b(?:forbidden|prohibited|mandatory|banned|off[- ]limits)\b/i,
  /\bnot\s+(?:allowed|permitted)\b/i,
];

/**
 * Tier 0's own bookkeeping, in the same shape ./severity.ts uses to keep its
 * markers out of severity classification. A block that consists of our markers
 * has no wording to protect; classifying the marker lines would let a
 * `[strata:…]` line decide a retention policy, which is the self-poisoning case
 * severity.ts documents. The regex is duplicated rather than imported because
 * severity.ts's copy is module-private and exporting it would move a barrel
 * export through the wiring gates.
 */
const MARKER_LINE = /^\s*\[strata:[a-z-]+]/;

/**
 * Classify a block's text for retention purposes.
 *
 * `undefined` means "no opinion": the text was absent, whitespace-only, or
 * consisted only of our markers. The caller keeps the tier it already had,
 * which is the fail-open half of a fail-closed rule -- there is nothing in the
 * block to protect, so there is nothing to promote.
 */
export function classifyRetentionText(text: string | undefined): RetentionClassification | undefined {
  if (text === undefined) return undefined;

  const body = text
    .split('\n')
    .filter((line) => !MARKER_LINE.test(line))
    .join('\n');
  if (body.trim() === '') return undefined;

  for (const pattern of DIRECTIVE) {
    if (pattern.test(body)) return { verdict: 'constraint', confident: true };
  }

  const hazardous = HAZARD.some((pattern) => pattern.test(body));
  if (!hazardous) return { verdict: 'ordinary', confident: true };

  return ASSERTION.test(body)
    ? { verdict: 'constraint', confident: true }
    : { verdict: 'uncertain', confident: false };
}

/**
 * How much of a tier's information a lossy operator is allowed to destroy.
 *
 * The order between `reference`, `truncate` and `compact` is a statement about
 * surviving bytes -- a pointer still resolves to the full content, `truncate`
 * keeps head and tail, `compact` replaces the block with a gist -- but only the
 * `verbatim` boundary is load-bearing today, because `verbatim` is the only
 * retention the promotion targets. It is written as a rank rather than as
 * `wanted === 'user_intent'` so that a future target stays under the same
 * never-demote rule instead of quietly escaping it.
 */
const strictness = (retention: TierRetention): number =>
  retention === 'verbatim' ? 3 : retention === 'reference' ? 2 : retention === 'truncate' ? 1 : 0;

/**
 * The safety net: the tier the block should carry, or `null` to leave it alone.
 *
 * Takes the retention policy as a parameter rather than importing
 * `TIER_RETENTION`, so that the policy has one owner (./triage.ts) and this
 * module has no runtime edge back to it.
 */
export function promoteTier(
  current: Tier,
  text: string | undefined,
  retention: Readonly<Record<Tier, TierRetention>>,
): TierPromotion | null {
  const classification = classifyRetentionText(text);
  if (classification === undefined) return null;
  if (classification.verdict === 'ordinary') return null;

  const wanted: NonGovernanceTier = 'user_intent';
  if (wanted === current) return null;
  // A pointer's content is not in the block, so there is nothing to protect.
  if (current === 'artifact_ref') return null;
  // Never demote: equality is rejected too, so a tier that already has the
  // target retention is left where it is rather than rewritten in place.
  if (strictness(retention[wanted]) <= strictness(retention[current])) return null;

  return { tier: wanted, verdict: classification.verdict };
}
