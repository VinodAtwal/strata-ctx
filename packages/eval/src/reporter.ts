import type { ArmResult, Claim, ClaimStatus, RunReport } from './types.js';

/**
 * F1-1: the reporter.
 *
 * Renders a `RunReport` as text and as JSON. Two rules govern the output:
 *
 * **Stable.** Same report in, same bytes out, always. Every list is emitted in a
 * defined order, every number is rounded before it is printed, and nothing
 * reads a clock or a locale. A report is meant to be committed next to the code
 * that produced it and diffed on the next run, and an output that reorders
 * itself between runs is noise that hides the one line that changed.
 *
 * **Honest about what it is.** Three distinctions the format refuses to blur,
 * because each one is a way a harness can report green without having worked:
 *
 * - A **negative control** is marked as one and reported in its own section, not
 *   mixed into the pass/fail table. "The negative control passed" and "the
 *   product passed" must never be the same word.
 * - **fail** and **error** are different. `fail` means the arm ran and got it
 *   wrong; `error` means the arm did not run. An error counted as a pass is a
 *   false green; an error counted as a fail is a false alarm.
 * - An arm that **never ran** reports no rate at all, rather than `0.0%`. A rate
 *   with no denominator behind it clears any gate it is measured against.
 */

const pad = (text: string, width: number): string => (text.length >= width ? text : text + ' '.repeat(width - text.length));

const MARK: Readonly<Record<string, string>> = Object.freeze({
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERR ',
});

const CLAIM_MARK: Readonly<Record<ClaimStatus, string>> = Object.freeze({
  observed: '[x]',
  not_observed: '[ ]',
  inconclusive: '[?]',
});

/** Percentages are printed fixed at one decimal so the column never shifts. */
const pct = (rate: number | null): string => (rate === null ? '   -  ' : `${(rate * 100).toFixed(1)}%`);

const armLine = (result: ArmResult): string => {
  const head = `  ${pad(MARK[result.status] ?? '????', 4)} ${pad(result.arm, 9)}`;
  const retained = pad(`${result.retainedConstraintIds.length}`, 3);
  const dropped = pad(`${result.droppedConstraintIds.length}`, 3);
  const violations = pad(`${result.violations.length}`, 3);
  const error = result.error === null ? '' : `  [${result.error}]`;
  return `${head} retained=${retained} dropped=${dropped} violations=${violations}${error}`;
};

const claimLines = (claims: readonly Claim[]): string[] =>
  claims.flatMap((claim) => [
    `  ${CLAIM_MARK[claim.status]} ${claim.id}: ${claim.statement}`,
    `      ${claim.detail}${claim.blocking ? '  (blocking)' : ''}`,
  ]);

/** The negative-control section. Empty only when the suite declares none. */
const negativeControlLines = (report: RunReport): string[] => {
  if (report.negativeControls.length === 0) {
    return ['  (none declared -- every number in this report is uninterpretable: a harness that', '   never fails cannot show it detects anything)'];
  }
  const lines: string[] = [];
  for (const control of report.negativeControls) {
    const verdict = control.fired ? 'FIRED   ' : 'DID NOT FIRE';
    const arms = control.failingArms.length === 0 ? '-' : control.failingArms.join(',');
    lines.push(`  ${pad(verdict, 12)} ${pad(control.caseId, 20)} failing arms: ${arms}`);
    lines.push(`               ${control.title}`);
  }
  return lines;
};

/**
 * The human-readable report.
 *
 * Fixed-width columns and no colour: this goes into files, diffs and logs.
 */
export function renderReport(report: RunReport): string {
  const { totals } = report;
  const lines: string[] = [];

  lines.push(`strata-ctx eval report  (${report.harness.name}@${report.harness.version}, offline)`);
  lines.push(
    `suite ${report.suite} "${report.suiteName}"  format v${report.formatVersion}  seed 0x${report.seed
      .toString(16)
      .padStart(8, '0')}  fixtureFormatVersion=${report.formatVersion}`,
  );
  lines.push('');
  lines.push(
    `cases=${totals.cases}  observations=${totals.observations}  pass=${totals.passed}  fail=${totals.failed}  error=${totals.errored}`,
  );
  lines.push('');

  lines.push('per-arm totals');
  lines.push(`  ${pad('arm', 10)}${pad('obs', 5)}${pad('pass', 6)}${pad('fail', 6)}${pad('err', 5)}${pad('viol', 6)}${pad('rate', 7)}${pad('retn', 6)}in/out tokens`);
  for (const arm of totals.byArm) {
    lines.push(
      `  ${pad(arm.arm, 10)}${pad(String(arm.observations), 5)}${pad(String(arm.passed), 6)}` +
        `${pad(String(arm.failed), 6)}${pad(String(arm.errored), 5)}${pad(String(arm.violations), 6)}` +
        `${pad(pct(arm.violationRate), 7)}${pad(String(arm.retentionFailures), 6)}${arm.inputTokens}/${arm.outputTokens}`,
    );
  }
  lines.push('');

  lines.push('execution order (interleaved, seeded: position is uncorrelated with arm)');
  for (const step of report.executionOrder) {
    lines.push(`  ${pad(String(step.position), 4)}${pad(step.arm, 11)}${step.caseId}`);
  }
  lines.push('');

  lines.push('cases');
  for (const evalCase of report.cases) {
    const tag = evalCase.negativeControl ? '[NEGATIVE CONTROL]' : '';
    lines.push(
      `  ${pad(evalCase.caseId, 20)}${evalCase.satisfied ? 'PASS' : 'FAIL'}  constraints=${evalCase.constraintCount}  ${tag}`,
    );
    lines.push(`    ${evalCase.title}`);
    for (const arm of evalCase.arms) lines.push(armLine(arm));
    for (const arm of evalCase.arms) {
      for (const violation of arm.violations) {
        lines.push(`      ! ${arm.arm} violated ${violation.constraintId} (${violation.kind}): ${violation.marker}`);
      }
    }
  }
  lines.push('');

  lines.push(`negative controls (${report.totals.negativeControlsFired}/${totals.negativeControls} fired)`);
  lines.push(...negativeControlLines(report));
  lines.push('');

  lines.push('claims');
  lines.push(...claimLines(report.claims));

  return `${lines.join('\n')}\n`;
}

/**
 * The JSON form, for machines and for committed artifacts.
 *
 * Key order follows insertion order rather than being sorted, because the
 * field order is the readable order and `JSON.stringify` on a fixed shape is
 * already stable. Whitespace is fixed at two spaces.
 */
export function renderReportJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Both renderings, in the order a directory of reports should be written in. */
export function renderReportPair(report: RunReport): { readonly text: string; readonly json: string } {
  return { text: renderReport(report), json: renderReportJson(report) };
}

/** One word, for a CI exit code. `fail` on any non-pass arm. */
export function reportVerdict(report: RunReport): 'pass' | 'fail' {
  return report.totals.failed === 0 && report.totals.errored === 0 ? 'pass' : 'fail';
}
