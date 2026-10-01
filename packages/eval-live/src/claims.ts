import type { Confidence, GateOutcome, GateStatus } from './gates.js';
import type { LiveRunReport } from './campaign.js';

/**
 * F2-2: the claims audit.
 *
 * A run produces numbers. A *claim* is a sentence built on top of them, and the
 * gap between the two is where overclaiming lives. `docs/development.md` M5 asks
 * for "every number High/Medium/Low with a source, a negative control result,
 * and an explicit list of what we do not claim" — this file is the third of those,
 * and the one that does the most work.
 *
 * Three rules:
 *
 * **Confidence is inherited, never assigned.** A claim cannot be more confident
 * than the weakest gate under it, and cannot be more confident than the campaign
 * that produced it. Hand-writing "high" next to a gate that reported "medium"
 * would make the field decorative.
 *
 * **A failed G1 makes every other claim conditional.** G1 is the negative
 * control. If it did not fire, the harness has not shown it can detect anything,
 * so "G2 shows 0% violations" is a claim about a broken instrument, not about
 * the treatment. Those claims are marked `invalidated` rather than quietly kept
 * at face value.
 *
 * **`notClaimed` is not a formality.** It is the audit's most useful field: the
 * claims a green report invites that the report does not support. A claim audit
 * that lists only what was found is a summary.
 */

export type AuditedStatus = GateStatus | 'invalidated';

export interface AuditedClaim {
  readonly id: string;
  /** A sentence, so a reader can quote it and be held to it. */
  readonly statement: string;
  readonly status: AuditedStatus;
  readonly confidence: Confidence;
  /** Where the number came from: a gate, a section, a file. */
  readonly source: string;
  readonly evidence: string;
  /** Every downgrade, carried through verbatim from the gate. */
  readonly reasons: readonly string[];
  readonly blocking: boolean;
}

export interface ClaimsAudit {
  readonly claims: readonly AuditedClaim[];
  /** Claims a reader could make from this report that it does not support. */
  readonly notClaimed: readonly string[];
}

const STATUS_WORD: Readonly<Record<AuditedStatus, string>> = Object.freeze({
  met: 'OBSERVED',
  not_met: 'NOT OBSERVED',
  inconclusive: 'INCONCLUSIVE',
  not_evaluated: 'NOT EVALUATED',
  invalidated: 'INVALIDATED',
});

const CLAIM_TEXT: Readonly<Record<string, string>> = Object.freeze({
  G1: 'The negative control reproduces governance decay.',
  G2: 'The pinned arm does not violate the constraints it was given.',
  G3: 'The treatment is non-inferior to the control on pass rate.',
});

/**
 * Build the audit.
 *
 * Only `met`, `not_met` and `inconclusive` gates become claims. `not_evaluated`
 * gates are routed to `notClaimed` instead, because the sentence "G4 is
 * non-inferior" is exactly the sort of thing that gets written down after a
 * report that quietly left G4 out.
 */
export function auditClaims(report: LiveRunReport): ClaimsAudit {
  const g1 = report.gates.find((g) => g.spec.id === 'G1');
  const controlValid = g1 !== undefined && g1.status === 'met';

  const claims: AuditedClaim[] = report.gates
    .filter((g): g is GateOutcome => g.status !== 'not_evaluated')
    .map((gate) => {
      const reasons = [...gate.reasons];
      let status: AuditedStatus = gate.status;
      if (!controlValid && gate.spec.id !== 'G1') {
        status = 'invalidated';
        reasons.unshift(
          'G1 did not fire, so the harness has not demonstrated it detects anything: this number describes an instrument that may be measuring nothing.',
        );
      }
      return {
        id: gate.spec.id,
        statement: CLAIM_TEXT[gate.spec.id] ?? gate.spec.title,
        status,
        confidence: gate.confidence,
        source: `gate ${gate.spec.id} (${gate.spec.threshold})`,
        evidence: gate.evidence,
        reasons,
        blocking: gate.spec.blocking,
      };
    });

  const blocked = report.gates.filter((g) => g.status === 'not_evaluated').map((g) => g.spec.id);
  const lowConfidence = claims.filter((c) => c.confidence !== 'high').map((c) => c.id);

  const notClaimed: string[] = [
    ...blocked.map(
      (id) =>
        `That any unmeasured gate was met: ${id} was not evaluated in this campaign, which is different from ${id} passing.`,
    ),
    ...(controlValid ? [] : ['That the harness can detect governance decay at all. G1 did not fire.']),
    ...report.campaign.caveats.map((c) => `That ${lowerFirst(c)}`),
    ...(lowConfidence.length === 0
      ? []
      : [`That any gate below high confidence (${lowConfidence.join(', ')}) is established rather than merely consistent with the data.`]),
    ...(report.totals.errored > 0
      ? [`That the ${report.totals.errored} errored observation(s) were failures rather than transport noise; they are counted separately for that reason.`]
      : []),
    'That any of this generalises beyond the models named in campaign.modelsObserved.',
  ];

  return { claims, notClaimed: [...new Set(notClaimed)] };
}

const lowerFirst = (text: string): string => (text.charAt(0).toLowerCase() + text.slice(1));

/**
 * Render the audit as markdown.
 *
 * Markdown rather than the report's fixed-width text because this is the
 * artifact that gets pasted into a release note, where a table survives and a
 * box drawing does not.
 */
export function renderClaimsAudit(report: LiveRunReport): string {
  const audit = auditClaims(report);
  const { campaign } = report;

  const lines: string[] = [
    `# Claims audit`,
    '',
    `Campaign ${campaign.observedAt} · model \`${campaign.model}\` · temperature ${campaign.temperature} ·`,
    `${report.totals.observations} observations over ${report.totals.cases} cases · ` +
      `${campaign.attempts} request(s), ${campaign.retries} retry(ies), ${campaign.infrastructureFailures} infrastructure failure(s).`,
    '',
    // All twelve pre-registered gates, including the ones this campaign could not
    // measure. A gate that is absent from the report reads as a gate that passed;
    // one printed as NOT EVALUATED reads as what it is.
    '## Gates',
    '',
    '| Gate | Status | Confidence | Threshold |',
    '|---|---|---|---|',
  ];

  for (const gate of report.gates) {
    lines.push(
      `| ${gate.spec.id}${gate.spec.blocking ? ' (blocking)' : ''} | ${STATUS_WORD[gate.status]} | ${gate.confidence.toUpperCase()} | ${gate.spec.threshold} |`,
    );
  }

  lines.push('', '## Claims', '', '| Gate | Status | Confidence | Claim |', '|---|---|---|---|');

  for (const claim of audit.claims) {
    lines.push(
      `| ${claim.id}${claim.blocking ? ' (blocking)' : ''} | ${STATUS_WORD[claim.status]} | ${claim.confidence.toUpperCase()} | ${claim.statement} |`,
    );
  }

  lines.push('', '### Evidence and downgrades', '');
  for (const claim of audit.claims) {
    lines.push(`**${claim.id}** — ${claim.evidence}`);
    if (claim.source !== '') lines.push(`  source: ${claim.source}`);
    for (const reason of claim.reasons) lines.push(`  - ${reason}`);
    if (claim.reasons.length === 0) lines.push('  - no downgrades');
    lines.push('');
  }

  lines.push('## What this report does not claim', '');
  for (const line of audit.notClaimed) lines.push(`- ${line}`);
  lines.push('');

  return lines.join('\n');
}